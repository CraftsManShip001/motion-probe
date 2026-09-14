#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
// Same zod instance as the MCP SDK (zod 3.25 ships the v4 API under `zod/v4`).
import { z } from 'zod/v4';
import {
  DEFAULT_PORT,
  NAMED_EASINGS,
  createBaselineSpec,
  specFromMotionTokens,
  summarize,
  type MotionDefinition,
  type MotionDocument,
  type MotionSpec,
  type RawTrace,
} from '@motion-probe/core';
import {
  CliError,
  DaemonClient,
  analyzeTrace,
  ensureDaemon,
  loadSpec,
  recordMotion,
  render,
  specTargets,
  validateSpec,
  type Daemon,
} from '@motion-probe/cli';
import { readFile } from 'node:fs/promises';

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const port = Number(process.env.MOTION_PROBE_PORT ?? DEFAULT_PORT);
const host = process.env.MOTION_PROBE_HOST;
const client = new DaemonClient(`http://127.0.0.1:${port}`);
// stdout carries the MCP protocol; everything human-readable goes to stderr.
const log = (message: string) => console.error(`[motion-probe-mcp] ${message}`);

/** Recent traces by session id, so reports and baselines can be derived without files. */
const traces = new Map<string, RawTrace>();
const remember = (sessionId: string, trace: RawTrace) => {
  traces.set(sessionId, trace);
  if (traces.size > 20) traces.delete(traces.keys().next().value!);
};

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });

async function guard(run: () => Promise<string>) {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error instanceof CliError || error instanceof Error ? error.message : String(error));
  }
}

const expectationSchema = z
  .looseObject({ target: z.string() })
  .describe(
    'One expectation. Checks: prop (translateX|translateY|scaleX|scaleY|rotation|opacity|boundsWidth|boundsHeight|left|top), ' +
      'from, to, tolerance, startMs, durationMs, settleMs (number | {value,tolerance} | {min,max}), maxOvershootPct, monotonic, ' +
      'easing (name or [x1,y1,x2,y2]), maxEasingRmse, maxStalls, maxDroppedFrames, minVisibleRatio, minFinalVisibleRatio, shouldMove, mustBeFound.',
  );

const specInput = {
  spec: z.object({ expectations: z.array(expectationSchema) }).optional().describe('Inline expectations to assert.'),
  specPath: z.string().optional().describe('Path to a spec JSON file (alternative to `spec`).'),
  format: z.enum(['text', 'json']).optional().describe('text (default, compact) or json (exact numbers).'),
};

const recordingInput = {
  idleMs: z.number().int().min(50).optional().describe('Stop after no change for this long once motion started (default 300).'),
  timeoutMs: z.number().int().min(100).optional().describe('Give up if nothing moves within this time (default 5000).'),
  maxDurationMs: z.number().int().min(100).optional().describe('Hard cap on recording length (default 15000).'),
  app: z
    .string()
    .optional()
    .describe('App connection id from motion_status, or a platform (ios | android), when several apps are connected (default: latest).'),
  occlusionGrid: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('n×n sample grid for detecting views that cover the target; 0 disables (default 6).'),
};

async function resolveSpec(args: { spec?: unknown; specPath?: string }): Promise<MotionSpec | undefined> {
  if (args.spec) return validateSpec(args.spec as MotionSpec, 'spec');
  if (args.specPath) return loadSpec(args.specPath);
  return undefined;
}

function report(sessionId: string | undefined, trace: RawTrace, spec: MotionSpec | undefined, format = 'text') {
  const analysis = analyzeTrace(trace, { spec });
  const body = render(analysis, format === 'json' ? 'json' : 'text');
  return sessionId ? `session ${sessionId}\n${body}` : body;
}

const server = new McpServer({ name: 'motion-probe', version: VERSION });

server.registerTool(
  'motion_status',
  {
    title: 'motion-probe status',
    description: 'Shows whether a React Native app with the motion probe is connected, and recent recording sessions.',
    annotations: { readOnlyHint: true },
  },
  () => guard(async () => JSON.stringify(await client.status(), null, 2)),
);

server.registerTool(
  'motion_record',
  {
    title: 'Record and verify an animation',
    description:
      'Arms the native probe on views with the given testIDs, performs the interaction — `command` (a handler the app ' +
      'registered with onMotionProbeCommand) or `trigger` (a shell command such as `maestro test flow.yaml`) — waits until motion settles and ' +
      'returns a compact report: per-property animations (from → to, duration, easing/spring fit), stalls, dropped frames, ' +
      'clipping and detected issues. With `spec`, also returns PASS/FAIL per expectation. ' +
      'Omit `trigger` only if you start the interaction within `timeoutMs` some other way; otherwise use motion_arm.',
    inputSchema: {
      targets: z.array(z.string()).optional().describe('testIDs to record. Defaults to the targets named in the spec.'),
      command: z
        .string()
        .optional()
        .describe('App command (onMotionProbeCommand handler) that performs the interaction after the probe is armed.'),
      trigger: z.string().optional().describe('Shell command that performs the interaction after the probe is armed.'),
      saveTracePath: z.string().optional().describe('Also write the raw trace JSON here.'),
      ...recordingInput,
      ...specInput,
    },
  },
  (args) =>
    guard(async () => {
      const spec = await resolveSpec(args);
      const targets = args.targets?.length ? args.targets : spec ? specTargets(spec) : [];
      if (!targets.length) throw new CliError('pass `targets` or a spec with expectations');
      const { trace, session } = await recordMotion(client, {
        targets,
        trigger: args.trigger,
        command: args.command,
        idleMs: args.idleMs,
        timeoutMs: args.timeoutMs,
        maxDurationMs: args.maxDurationMs,
        app: args.app,
        occlusionGrid: args.occlusionGrid,
        log,
      });
      remember(session.sessionId, trace);
      if (args.saveTracePath) await writeFile(args.saveTracePath, JSON.stringify(trace));
      return report(session.sessionId, trace, spec, args.format);
    }),
);

server.registerTool(
  'motion_arm',
  {
    title: 'Arm the probe (interaction performed by another tool)',
    description:
      'Starts recording the given testIDs and returns immediately with a sessionId. Then perform the interaction with ' +
      'another tool (e.g. a Maestro or mobile MCP tap) and call motion_report with the sessionId.',
    inputSchema: { targets: z.array(z.string()).min(1).describe('testIDs to record.'), ...recordingInput },
  },
  (args) =>
    guard(async () => {
      await client.waitForApp(15000, args.app);
      const session = await client.arm({
        targets: args.targets,
        idleMs: args.idleMs,
        timeoutMs: args.timeoutMs,
        maxDurationMs: args.maxDurationMs,
        app: args.app,
        occlusionGrid: args.occlusionGrid,
      });
      return JSON.stringify({ sessionId: session.sessionId, found: session.found, missing: session.missing });
    }),
);

server.registerTool(
  'motion_send',
  {
    title: 'Run an app command',
    description:
      'Runs a handler the app registered with onMotionProbeCommand (e.g. "open-sheet") — a deterministic trigger that needs ' +
      'no deep link (iOS confirms every simulator openurl) and no UI automation. Use it between motion_arm and motion_report.',
    inputSchema: {
      name: z.string().min(1).describe('Command name the app handles.'),
      app: recordingInput.app,
    },
  },
  (args) =>
    guard(async () => {
      await client.waitForApp(15000, args.app);
      await client.command(args.name, args.app);
      return `sent ${args.name}`;
    }),
);

server.registerTool(
  'motion_report',
  {
    title: 'Report an armed recording',
    description: 'Waits for a session started with motion_arm to settle and returns its report (and assertions with `spec`).',
    inputSchema: { sessionId: z.string(), ...specInput },
  },
  (args) =>
    guard(async () => {
      const spec = await resolveSpec(args);
      const trace = traces.get(args.sessionId) ?? (await client.waitForTrace(args.sessionId, 30000));
      remember(args.sessionId, trace);
      return report(args.sessionId, trace, spec, args.format);
    }),
);

server.registerTool(
  'motion_analyze',
  {
    title: 'Analyze a saved trace',
    description: 'Re-analyzes a raw trace file (from saveTracePath / --save) without touching the device, optionally against a spec.',
    inputSchema: { tracePath: z.string(), ...specInput },
    annotations: { readOnlyHint: true },
  },
  (args) =>
    guard(async () => {
      const trace = JSON.parse(await readFile(args.tracePath, 'utf8')) as RawTrace;
      return report(undefined, trace, await resolveSpec(args), args.format);
    }),
);

server.registerTool(
  'motion_baseline',
  {
    title: 'Create a baseline spec',
    description:
      'Turns a known-good recording into a spec (durations with tolerance, easing, overshoot, stalls, final visibility) ' +
      'so later recordings can be checked for motion regressions.',
    inputSchema: {
      sessionId: z.string().optional().describe('A session recorded in this MCP server.'),
      tracePath: z.string().optional().describe('Or a raw trace file.'),
      outPath: z.string().optional().describe('Write the spec JSON here.'),
      tolerancePct: z.number().min(0).max(100).optional().describe('Relative timing tolerance (default 15).'),
    },
  },
  (args) =>
    guard(async () => {
      const trace = args.sessionId
        ? (traces.get(args.sessionId) ?? (await client.waitForTrace(args.sessionId, 1000)))
        : args.tracePath
          ? (JSON.parse(await readFile(args.tracePath, 'utf8')) as RawTrace)
          : undefined;
      if (!trace) throw new CliError('pass `sessionId` or `tracePath`');
      const spec = createBaselineSpec(summarize(trace), { timingTolerancePct: args.tolerancePct });
      const json = JSON.stringify(spec, null, 2);
      if (args.outPath) await writeFile(args.outPath, `${json}\n`);
      return args.outPath ? `wrote ${spec.expectations.length} expectations to ${args.outPath}\n${json}` : json;
    }),
);

server.registerTool(
  'motion_spec_from_tokens',
  {
    title: 'Create a spec from design motion tokens',
    description:
      'Builds expectations from design tokens (W3C DTCG `duration`, `cubicBezier`, `transition`, plus `spring` with ' +
      'dampingRatio or damping/stiffness/mass) and a list of motions, so the running app can be checked against the ' +
      "design system's motion spec with motion_record.",
    inputSchema: {
      motionsPath: z.string().optional().describe('Motion document JSON: { tokens?, motions: [...] }.'),
      motions: z
        .array(z.looseObject({ target: z.string(), prop: z.string() }))
        .optional()
        .describe(
          'Inline motions: { target, prop, from?, to?, duration?, easing?, transition?, spring?, fullyVisibleAtEnd?, smooth? } ' +
            'where duration/easing/transition/spring are token references like "motion.duration.normal" or literals.',
        ),
      tokens: z.record(z.string(), z.unknown()).optional().describe('Inline token document.'),
      tokenPaths: z.array(z.string()).optional().describe('Token files (DTCG or plain JSON), merged in order.'),
      outPath: z.string().optional().describe('Write the spec JSON here.'),
      tolerancePct: z.number().min(0).max(100).optional().describe('Relative duration tolerance (default 10).'),
    },
  },
  (args) =>
    guard(async () => {
      const file = args.motionsPath ? (JSON.parse(await readFile(args.motionsPath, 'utf8')) as MotionDocument) : undefined;
      const document: MotionDocument = {
        tokens: file?.tokens,
        motions: (args.motions as MotionDefinition[] | undefined) ?? file?.motions ?? [],
      };
      const tokenFiles = await Promise.all((args.tokenPaths ?? []).map(async (p) => JSON.parse(await readFile(p, 'utf8')) as unknown));
      const spec = specFromMotionTokens(document, {
        tokens: [...tokenFiles, ...(args.tokens ? [args.tokens] : [])],
        timingTolerancePct: args.tolerancePct,
      });
      const json = JSON.stringify(spec, null, 2);
      if (args.outPath) await writeFile(args.outPath, `${json}\n`);
      return args.outPath ? `wrote ${spec.expectations.length} expectations to ${args.outPath}\n${json}` : json;
    }),
);

server.registerTool(
  'motion_easings',
  {
    title: 'List easing names',
    description: 'Named easing curves usable in spec `easing`, including React Native / Reanimated defaults.',
    annotations: { readOnlyHint: true },
  },
  () =>
    guard(async () =>
      Object.entries(NAMED_EASINGS)
        .map(([name, { description }]) => `${name.padEnd(16)} ${description}`)
        .join('\n'),
    ),
);

// Host the daemon for the lifetime of the MCP server so the app stays connected between tool calls.
let daemon: Daemon | undefined;
try {
  daemon = await ensureDaemon(client, { port, host, log });
} catch (error) {
  log(`could not start daemon on :${port} (${String(error)}); tools will retry an existing daemon`);
}

const shutdown = async () => {
  await daemon?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
log(`ready (daemon ${daemon ? `hosted on :${port}` : `expected on :${port}`})`);
