import type { AppInfo, RawTrace } from '@motion-probe/core';
import type { ArmRequest, SessionState } from './daemon.js';

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  targets: string[];
  found: string[];
  missing: string[];
  error?: string;
  appInfo?: AppInfo;
  trace?: RawTrace;
}

export interface DaemonStatus {
  protocol: number;
  apps: Array<AppInfo & { id: string; connectedAt: number }>;
  sessions: SessionInfo[];
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

/** HTTP client for a running `motion-probe serve` daemon. */
export class DaemonClient {
  constructor(readonly baseUrl: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new CliError(`cannot reach motion-probe daemon at ${this.baseUrl} (${String((error as Error).cause ?? error)})`);
    }
    const payload = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new CliError(payload.error ?? `daemon responded ${res.status}`);
    return payload;
  }

  async reachable(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }

  status() {
    return this.request<DaemonStatus>('GET', '/status');
  }

  arm(request: ArmRequest) {
    return this.request<SessionInfo>('POST', '/sessions', request);
  }

  session(id: string, waitMs = 0) {
    return this.request<SessionInfo>('GET', `/sessions/${id}${waitMs ? `?wait=${waitMs}` : ''}`);
  }

  cancel(id: string) {
    return this.request<SessionInfo>('DELETE', `/sessions/${id}`);
  }

  async waitForApp(timeoutMs: number): Promise<DaemonStatus['apps'][number]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { apps } = await this.status();
      if (apps.length) return apps[0];
      if (Date.now() > deadline) {
        throw new CliError(
          'no app connected. Is a development build running with installMotionProbe()? ' +
            'Android: run `adb reverse tcp:7357 tcp:7357`. Physical device: `motion-probe serve --host 0.0.0.0`.',
        );
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async waitForTrace(id: string, timeoutMs: number): Promise<RawTrace> {
    const session = await this.session(id, timeoutMs);
    if (session.state === 'done' && session.trace) return session.trace;
    throw new CliError(`recording ${id} did not finish: ${session.error ?? session.state}`);
  }
}
