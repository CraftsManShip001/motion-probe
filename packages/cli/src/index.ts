export { CliError, DaemonClient, type DaemonStatus, type SessionInfo } from './api.js';
export { startDaemon, type ArmRequest, type Daemon, type DaemonOptions, type SessionState } from './daemon.js';
export { ensureDaemon, recordMotion, runTrigger, type RecordRequest } from './record.js';
export {
  analyzeTrace,
  exportOtlp,
  loadSpec,
  parseFormat,
  render,
  specTargets,
  validateSpec,
  type Analysis,
  type Format,
} from './output.js';
