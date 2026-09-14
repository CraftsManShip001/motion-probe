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
      if (message.type === 'command') {
        const handled = message.name === 'open-sheet';
        socket.send(JSON.stringify({ type: 'command-result', commandId: message.commandId, handled }));
        return;
      }
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

  it('performs the interaction with an app command', async () => {
    const client = await setup();
    await recordMotion(client, { targets: ['toast'], command: 'open-sheet', waitAppMs: 2000, log: quiet });
    expect(app!.received.map((m) => m.type)).toEqual(['arm', 'command']);
  });

  it('cancels the recording when the app has no handler for the command', async () => {
    const client = await setup('hang');
    await expect(recordMotion(client, { targets: ['toast'], command: 'nope', waitAppMs: 2000, log: quiet })).rejects.toThrow(
      /no handler/,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(app!.received.map((m) => m.type)).toEqual(['arm', 'command', 'cancel']);
  });

  it('forwards named commands to the app and rejects unknown ones', async () => {
    const client = await setup();
    await expect(client.command('open-sheet')).resolves.toMatchObject({ handled: true });
    expect(app!.received.at(-1)).toMatchObject({ type: 'command', name: 'open-sheet' });
    await expect(client.command('close-everything')).rejects.toThrow(/no handler/);
    // Apps can be picked by platform as well as by connection id.
    await expect(client.command('open-sheet', 'ios')).resolves.toMatchObject({ handled: true });
    await expect(client.command('open-sheet', 'android')).rejects.toThrow(/no app connected/);
  });

  it('refuses commands when no app is connected', async () => {
    daemon = await startDaemon({ port: 0, log: quiet });
    const client = new DaemonClient(`http://127.0.0.1:${daemon.port}`);
    await expect(client.command('open-sheet')).rejects.toThrow(/no app connected/);
  });

  it('reports daemon status with connected apps', async () => {
    const client = await setup();
    const status = await client.status();
    expect(status.apps).toHaveLength(1);
    expect(status.apps[0]).toMatchObject({ name: 'fake-app', platform: 'ios' });
  });
});
