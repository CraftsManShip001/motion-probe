#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  DEFAULT_PORT,
  MotionTokenError,
  NAMED_EASINGS,
  createBaselineSpec,
  specFromMotionTokens,
  summarize,
  type MotionDocument,
  type MotionSpec,
  type RawTrace,
} from '@motion-probe/core';
import { CliError, DaemonClient } from './api.js';
import { startDaemon } from './daemon.js';
import { emit, loadJson, loadSpec, parseFormat, specTargets, type EmitOptions } from './output.js';
import { ensureDaemon, recordMotion } from './record.js';

const HELP = `motion-probe — verify React Native animations from what the UI layer actually renders

Usage:
  motion-probe serve            [--port 7357] [--host 127.0.0.1]
  motion-probe status
  motion-probe record           -t <testID,...> [--trigger "<cmd>"] [--spec spec.json] [--format text|json|otlp]
  motion-probe arm              -t <testID,...>   # prints a session id; trigger the interaction yourself
  motion-probe report           <sessionId> [--spec spec.json] [--format ...]
  motion-probe analyze          <trace.json> [--spec spec.json] [--format ...]
  motion-probe baseline         <trace.json> [--out spec.json] [--tolerance 15]
  motion-probe spec-from-tokens <motions.json> [--tokens tokens.json,...] [--out spec.json] [--tolerance 10]
  motion-probe easings

Options:
  -t, --targets         Comma-separated testIDs to record (defaults to the targets in --spec)
      --trigger         Shell command that performs the interaction after the probe is armed
                        (e.g. "xcrun simctl openurl booted myapp://open-sheet" or "maestro test flow.yaml")
  -s, --spec            Expectations file; exit code 1 when any expectation fails
  -f, --format          text (default, compact for agents) | json | otlp (OpenTelemetry traces)
      --idle            ms without change that ends a recording once motion started (default 300)
      --timeout         ms to wait for motion to start (default 5000)
      --max             hard cap in ms (default 15000)
      --gap             ms of no change that splits two animations of the same property (default 300)
      --occlusion-grid  n×n sample grid for detecting views covering the target; 0 disables (default 6)
      --save            write the raw trace to a file (re-analyze later with \`analyze\`)
      --write-baseline  write a spec generated from this recording (motion regression test)
      --otlp-endpoint   POST the report as OTLP/JSON traces to a collector (e.g. http://localhost:4318)
      --tokens          design token files (W3C DTCG or plain JSON) for \`spec-from-tokens\`
      --out             output file for \`baseline\` / \`spec-from-tokens\` (default stdout)
      --tolerance       relative timing tolerance in % (baseline 15, spec-from-tokens 10)
      --wait-app        ms to wait for an app to connect (default 15000)
      --app             app connection id from \`status\` when several apps are connected (default: latest)
  -p, --port            daemon port (default ${DEFAULT_PORT})

Exit codes: 0 ok · 1 expectations failed · 2 error`;

const OPTIONS = {
  targets: { type: 'string', short: 't' },
  trigger: { type: 'string' },
  spec: { type: 'string', short: 's' },
  format: { type: 'string', short: 'f' },
  idle: { type: 'string' },
  timeout: { type: 'string' },
  max: { type: 'string' },
  gap: { type: 'string' },
  'occlusion-grid': { type: 'string' },
  save: { type: 'string' },
  'write-baseline': { type: 'string' },
  'otlp-endpoint': { type: 'string' },
  tokens: { type: 'string' },
  out: { type: 'string', short: 'o' },
  tolerance: { type: 'string' },
  'wait-app': { type: 'string' },
  app: { type: 'string' },
  port: { type: 'string', short: 'p' },
  host: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

function num(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CliError(`--${name} must be a non-negative number`);
  return n;
}

function recordingOptions(values: Values) {
  return {
    idleMs: num(values.idle, 300, 'idle'),
    timeoutMs: num(values.timeout, 5000, 'timeout'),
    maxDurationMs: num(values.max, 15000, 'max'),
    occlusionGrid: values['occlusion-grid'] !== undefined ? num(values['occlusion-grid'], 6, 'occlusion-grid') : undefined,
    app: values.app,
  };
}

async function emitOptions(values: Values): Promise<EmitOptions> {
  return {
    format: parseFormat(values.format),
    spec: values.spec ? await loadSpec(values.spec) : undefined,
    gapMs: values.gap !== undefined ? num(values.gap, 300, 'gap') : undefined,
    save: values.save,
    writeBaseline: values['write-baseline'],
    otlpEndpoint: values['otlp-endpoint'],
  };
}

async function resolveTargets(values: Values, loadedSpec?: MotionSpec) {
  const spec = loadedSpec ?? (values.spec ? await loadSpec(values.spec) : undefined);
  const targets = values.targets
    ? values.targets.split(',').map((t) => t.trim()).filter(Boolean)
    : spec
      ? specTargets(spec)
      : [];
  if (!targets.length) throw new CliError('pass --targets <testID,...> or --spec with expectations');
  return targets;
}

async function writeSpec(spec: MotionSpec, out: string | undefined) {
  const json = `${JSON.stringify(spec, null, 2)}\n`;
  if (!out) {
    process.stdout.write(json);
    return;
  }
  await writeFile(out, json);
  console.error(`spec with ${spec.expectations.length} expectations written to ${out}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true });
  if (!command || command === 'help' || command === '--help' || command === '-h' || values.help) {
    console.log(HELP);
    return 0;
  }

  const port = num(values.port, DEFAULT_PORT, 'port');
  const client = new DaemonClient(`http://127.0.0.1:${port}`);

  switch (command) {
    case 'serve': {
      const host = values.host ?? '127.0.0.1';
      await startDaemon({ port, host });
      console.error(`motion-probe daemon listening on ${host}:${port} (apps connect to ws://<host>:${port}/app)`);
      await new Promise(() => {});
      return 0;
    }
    case 'status':
      console.log(JSON.stringify(await client.status(), null, 2));
      return 0;

    case 'record': {
      const output = await emitOptions(values);
      const targets = await resolveTargets(values, output.spec);
      const daemon = await ensureDaemon(client, { port, host: values.host });
      try {
        const { trace } = await recordMotion(client, {
          targets,
          trigger: values.trigger,
          waitAppMs: num(values['wait-app'], 15000, 'wait-app'),
          ...recordingOptions(values),
        });
        return await emit(trace, output);
      } finally {
        await daemon?.close();
      }
    }

    case 'arm': {
      const targets = await resolveTargets(values);
      await client.waitForApp(num(values['wait-app'], 15000, 'wait-app'));
      const session = await client.arm({ targets, ...recordingOptions(values) });
      console.log(JSON.stringify({ sessionId: session.sessionId, found: session.found, missing: session.missing }));
      return 0;
    }

    case 'report': {
      const id = positionals[0];
      if (!id) throw new CliError('usage: motion-probe report <sessionId>');
      const { timeoutMs, maxDurationMs } = recordingOptions(values);
      const trace = await client.waitForTrace(id, timeoutMs + maxDurationMs + 5000);
      return emit(trace, await emitOptions(values));
    }

    case 'analyze': {
      const path = positionals[0];
      if (!path) throw new CliError('usage: motion-probe analyze <trace.json>');
      return emit(await loadJson<RawTrace>(path, 'trace'), { ...(await emitOptions(values)), save: undefined });
    }

    case 'baseline': {
      const path = positionals[0];
      if (!path) throw new CliError('usage: motion-probe baseline <trace.json> [--out spec.json]');
      const report = summarize(await loadJson<RawTrace>(path, 'trace'), {
        gapMs: values.gap !== undefined ? num(values.gap, 300, 'gap') : undefined,
      });
      const spec = createBaselineSpec(report, {
        timingTolerancePct: num(values.tolerance, 15, 'tolerance'),
        description: `baseline from ${path}`,
      });
      await writeSpec(spec, values.out);
      return 0;
    }

    case 'spec-from-tokens': {
      const path = positionals[0];
      if (!path) throw new CliError('usage: motion-probe spec-from-tokens <motions.json> [--tokens tokens.json,...]');
      const document = await loadJson<MotionDocument>(path, 'motion document');
      const tokenFiles = (values.tokens ?? '').split(',').map((f) => f.trim()).filter(Boolean);
      const tokens = await Promise.all(tokenFiles.map((file) => loadJson<unknown>(file, 'tokens')));
      try {
        const spec = specFromMotionTokens(document, {
          tokens,
          timingTolerancePct: num(values.tolerance, 10, 'tolerance'),
          description: `from ${path}`,
        });
        await writeSpec(spec, values.out);
      } catch (error) {
        if (error instanceof MotionTokenError) throw new CliError(error.message);
        throw error;
      }
      return 0;
    }

    case 'easings':
      for (const [name, { description }] of Object.entries(NAMED_EASINGS)) console.log(`${name.padEnd(16)} ${description}`);
      return 0;

    default:
      throw new CliError(`unknown command "${command}"\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof CliError ? `error: ${error.message}` : error);
    process.exitCode = error instanceof CliError ? error.exitCode : 2;
  },
);
