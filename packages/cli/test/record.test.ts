import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { APP_SOCKET_PATH, NAMED_EASINGS, type DaemonToApp, type RawTrace } from '@motion-probe/core';
import { analyzeTrace, CliError, DaemonClient, recordMotion, startDaemon, type Daemon } from '../src/index.js';
import { synthesize, timing } from '../../core/test/synthetic.js';

const quiet = () => {};
const cubicOut = NAMED_EASINGS['cubic-out'].fn;

function toastTrace(targets: string[]): RawTrace {
  return synthesize({
    durationMs: 700,
    targets: targets.map((id) => ({
      id,
      at: (t: number) => {
        const ty = timing(t, 50, 250, 60, 30, cubicOut);
        return { translateY: ty, height: 44, visibleRatio: Math.max(0, Math.min(1, (60 - ty) / 44)) };
      },
    })),
  });
}

interface FakeApp {
  socket: WebSocket;
  received: DaemonToApp[];
}

/** Stands in for the React Native client: answers `arm` with a synthetic trace. */
function connectFakeApp(port: number, behavior: 'record' | 'hang' | 'disconnect' = 'record'): Promise<FakeApp> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${APP_SOCKET_PATH}`);
    const app: FakeApp = { socket, received: [] };
    socket.on('error', reject);
    socket.on('open', () => {
      socket.send(JSON.stringify({ type: 'hello', protocol: 1, app: { platform: 'ios', name: 'fake-app' } }));
      resolve(app);
    });
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as DaemonToApp;
      app.received.push(message);
      if (message.type !== 'arm') return;
      socket.send(JSON.stringify({ type: 'armed', sessionId: message.sessionId, found: message.targets, missing: [] }));
      if (behavior === 'record') {
        setTimeout(() => {
          socket.send(JSON.stringify({ type: 'trace', sessionId: message.sessionId, trace: toastTrace(message.targets) }));
        }, 20);
      } else if (behavior === 'disconnect') {
        setTimeout(() => socket.close(), 20);
      }
    });
  });
}

let daemon: Daemon | undefined;
let app: FakeApp | undefined;

afterEach(async () => {
  app?.socket.close();
  await daemon?.close();
  app = undefined;
  daemon = undefined;
});

async function setup(behavior?: 'record' | 'hang' | 'disconnect') {
  daemon = await startDaemon({ port: 0, log: quiet });
  const client = new DaemonClient(`http://127.0.0.1:${daemon.port}`);
  app = await connectFakeApp(daemon.port, behavior);
  return client;
}

describe('recordMotion (daemon ↔ app protocol)', () => {
  it('arms, runs the trigger, and returns the trace', async () => {
    const client = await setup();
    const { trace, session } = await recordMotion(client, { targets: ['toast'], trigger: 'true', waitAppMs: 2000, log: quiet });

    expect(session.found).toEqual(['toast']);
    expect(app!.received[0]).toMatchObject({ type: 'arm', targets: ['toast'], idleMs: 300 });

    const { report, exitCode } = analyzeTrace(trace, { spec: { expectations: [{ target: 'toast', minFinalVisibleRatio: 0.99 }] } });
    expect(exitCode).toBe(1);
    expect(report.issues.map((i) => i.code)).toContain('clipped-at-end');
  });

  it('cancels the recording when the trigger fails', async () => {
    const client = await setup('hang');
    await expect(recordMotion(client, { targets: ['toast'], trigger: 'exit 3', waitAppMs: 2000, log: quiet })).rejects.toThrow(
      /trigger exited with code 3/,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(app!.received.map((m) => m.type)).toEqual(['arm', 'cancel']);
  });

  it('reports a session error when the app disconnects mid-recording', async () => {
    const client = await setup('disconnect');
    await expect(recordMotion(client, { targets: ['toast'], waitAppMs: 2000, log: quiet })).rejects.toThrow(/app disconnected/);
  });

  it('explains how to connect when no app is running', async () => {
    daemon = await startDaemon({ port: 0, log: quiet });
    const client = new DaemonClient(`http://127.0.0.1:${daemon.port}`);
    const error = await recordMotion(client, { targets: ['toast'], waitAppMs: 300, log: quiet }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(String((error as Error).message)).toMatch(/installMotionProbe/);
  });

  it('reports daemon status with connected apps', async () => {
    const client = await setup();
    const status = await client.status();
    expect(status.apps).toHaveLength(1);
    expect(status.apps[0]).toMatchObject({ name: 'fake-app', platform: 'ios' });
  });
});
