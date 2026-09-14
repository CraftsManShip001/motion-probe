import type { AppInfo, RawTrace } from './schema.js';

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7357;
/** WebSocket path apps connect to on the daemon. */
export const APP_SOCKET_PATH = '/app';

export interface ArmCommand {
  type: 'arm';
  sessionId: string;
  targets: string[];
  /** Stop once no target changed for this long after motion started. */
  idleMs: number;
  /** Give up if nothing moved within this time. */
  timeoutMs: number;
  maxDurationMs: number;
  /** Sample grid size for occlusion detection (n × n); 0 disables it. Default 6. */
  occlusionGrid?: number;
}

export interface CancelCommand {
  type: 'cancel';
  sessionId: string;
}

/**
 * Runs a named handler the app registered with `onMotionProbeCommand` (e.g. "open-sheet"), so scripts
 * and agents can trigger the interaction under test without deep links or UI automation.
 */
export interface AppCommand {
  type: 'command';
  commandId: string;
  name: string;
}

export type DaemonToApp = ArmCommand | CancelCommand | AppCommand;

export type AppToDaemon =
  | { type: 'hello'; protocol: number; app: AppInfo }
  | { type: 'armed'; sessionId: string; found: string[]; missing: string[] }
  | { type: 'trace'; sessionId: string; trace: RawTrace }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'command-result'; commandId: string; handled: boolean; error?: string };
