import type { AppToDaemon, DaemonToApp } from '@motion-probe/core';
import { NativeModules, Platform } from 'react-native';

import { MotionProbeNative } from './native';
import { startRecording, type Recording } from './recorder';

const PROTOCOL_VERSION = 1;
const DEFAULT_PORT = 7357;

export interface InstallOptions {
  /** Full daemon URL. Defaults to ws://<metro host>:7357/app. */
  url?: string;
  port?: number;
  appName?: string;
  /** Log connection state changes. */
  verbose?: boolean;
}

/** Host of the Metro server the bundle was loaded from, so physical devices reach the dev machine. */
function devServerHost(): string | undefined {
  try {
    const sourceCode = NativeModules.SourceCode as { scriptURL?: string; getConstants?: () => { scriptURL?: string } } | undefined;
    const scriptURL = sourceCode?.scriptURL ?? sourceCode?.getConstants?.().scriptURL;
    return scriptURL?.match(/^https?:\/\/([^/:]+)/)?.[1];
  } catch {
    return undefined;
  }
}

let uninstall: (() => void) | undefined;

/**
 * Connects the app to a local `motion-probe serve` daemon so the CLI (or an agent) can arm
 * recordings. Call once in development builds: `if (__DEV__) installMotionProbe()`.
 */
export function installMotionProbe(options: InstallOptions = {}): () => void {
  if (uninstall) return uninstall;
  if (!MotionProbeNative) {
    console.warn('[motion-probe] native module not linked — rebuild the app (Expo Go is not supported).');
    return () => {};
  }

  // Try the Metro host (reaches the dev machine from physical devices), then localhost
  // (simulators, `adb reverse`, or a daemon bound to 127.0.0.1).
  const port = options.port ?? DEFAULT_PORT;
  const host = devServerHost();
  const urls = options.url
    ? [options.url]
    : [...new Set([host && host !== '10.0.2.2' ? host : undefined, 'localhost'].filter(Boolean))].map(
        (h) => `ws://${h}:${port}/app`,
      );
  let attempt = 0;
  const log = (...args: unknown[]) => options.verbose && console.log('[motion-probe]', ...args);

  let socket: WebSocket | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const recordings = new Map<string, Recording>();

  const send = (message: AppToDaemon) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const handle = (message: DaemonToApp) => {
    if (message.type === 'cancel') {
      recordings.get(message.sessionId)?.cancel();
      return;
    }
    if (message.type !== 'arm') return;

    for (const recording of recordings.values()) recording.cancel();
    const { sessionId } = message;
    const recording = startRecording(message.targets, {
      idleMs: message.idleMs,
      timeoutMs: message.timeoutMs,
      maxDurationMs: message.maxDurationMs,
      occlusionGrid: message.occlusionGrid,
      appName: options.appName,
    });
    recordings.set(sessionId, recording);
    recording.armed
      .then((result) => send({ type: 'armed', sessionId, found: result.found, missing: result.missing }))
      .catch((error: unknown) => send({ type: 'error', sessionId, message: String(error) }));
    recording.done
      .then((trace) => send({ type: 'trace', sessionId, trace }))
      .catch((error: unknown) => send({ type: 'error', sessionId, message: String(error) }))
      .finally(() => recordings.delete(sessionId));
  };

  const connect = () => {
    if (stopped) return;
    const url = urls[attempt++ % urls.length];
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      log('connected', url);
      send({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        app: {
          name: options.appName,
          platform: Platform.OS === 'android' ? 'android' : 'ios',
          osVersion: String(Platform.Version),
        },
      });
    };
    ws.onmessage = (event) => {
      try {
        handle(JSON.parse(String(event.data)) as DaemonToApp);
      } catch (error) {
        send({ type: 'error', message: `bad message: ${String(error)}` });
      }
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (socket === ws) socket = undefined;
      for (const recording of recordings.values()) recording.cancel();
      if (!stopped) retry = setTimeout(connect, attempt % urls.length === 0 ? 2000 : 0);
    };
  };

  connect();

  uninstall = () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    socket?.close();
    uninstall = undefined;
  };
  return uninstall;
}
