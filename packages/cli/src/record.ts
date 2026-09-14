import { spawn } from 'node:child_process';
import type { RawTrace } from '@motion-probe/core';
import { CliError, DaemonClient, type SessionInfo } from './api.js';
import { startDaemon, type Daemon } from './daemon.js';

export interface RecordRequest {
  targets: string[];
  /** Shell command that performs the interaction once the probe is armed. */
  trigger?: string;
  idleMs?: number;
  timeoutMs?: number;
  maxDurationMs?: number;
  waitAppMs?: number;
  /** App connection id (see `status`) when several apps are connected. Defaults to the latest. */
  app?: string;
  /** Occlusion sample grid (n × n); 0 disables occlusion detection. */
  occlusionGrid?: number;
  log?: (message: string) => void;
}

const stderr = (message: string) => console.error(message);

export function runTrigger(command: string, log = stderr): Promise<number> {
  log(`trigger: ${command}`);
  return new Promise((resolve, reject) => {
    // stdout stays reserved for reports (and for the MCP protocol); trigger output goes to stderr.
    const child = spawn(command, { shell: true, stdio: ['ignore', process.stderr, process.stderr] });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Starts an in-process daemon when none is listening on the client's port. */
export async function ensureDaemon(
  client: DaemonClient,
  options: { port: number; host?: string; log?: (message: string) => void },
): Promise<Daemon | undefined> {
  if (await client.reachable()) return undefined;
  const log = options.log ?? stderr;
  const daemon = await startDaemon({ port: options.port, host: options.host, log: (m) => log(`[daemon] ${m}`) });
  log(`started daemon on :${options.port}; waiting for the app to connect…`);
  return daemon;
}

/** Arms the probe, runs the optional trigger and resolves with the raw trace once motion settled. */
export async function recordMotion(
  client: DaemonClient,
  request: RecordRequest,
): Promise<{ trace: RawTrace; session: SessionInfo }> {
  const log = request.log ?? stderr;
  const idleMs = request.idleMs ?? 300;
  const timeoutMs = request.timeoutMs ?? 5000;
  const maxDurationMs = request.maxDurationMs ?? 15000;

  const latest = await client.waitForApp(request.waitAppMs ?? 15000);
  const session = await client.arm({
    targets: request.targets,
    idleMs,
    timeoutMs,
    maxDurationMs,
    app: request.app,
    occlusionGrid: request.occlusionGrid,
  });
  const app = session.appInfo ?? latest;
  log(`armed ${session.sessionId} on ${app.name ?? app.platform} · targets: ${request.targets.join(', ')}`);
  if (session.missing.length) log(`not on screen yet (picked up if they mount): ${session.missing.join(', ')}`);

  if (request.trigger) {
    const code = await runTrigger(request.trigger, log);
    if (code !== 0) {
      await client.cancel(session.sessionId).catch(() => {});
      throw new CliError(`trigger exited with code ${code}`);
    }
  }
  const trace = await client.waitForTrace(session.sessionId, timeoutMs + maxDurationMs + 5000);
  return { trace, session };
}
