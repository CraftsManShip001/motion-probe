import type { AppInfo, EndReason, RawTrace } from '@motion-probe/core';

import { MotionProbeNative, type NativeDrain, type NativeStartResult } from './native';

export interface RecordOptions {
  /** Stop after nothing changed for this long once motion started. Default 300ms. */
  idleMs?: number;
  /** Stop if nothing moved within this time. Default 5000ms. */
  timeoutMs?: number;
  /** Hard cap enforced natively. Default 15000ms. */
  maxDurationMs?: number;
  pollMs?: number;
  /** Occlusion sample grid (n × n); 0 disables occlusion detection. Default 6. */
  occlusionGrid?: number;
  appName?: string;
}

export interface Recording {
  /** Resolves once the native probe is sampling (safe to trigger the interaction). */
  armed: Promise<NativeStartResult>;
  /** Resolves with the raw trace when motion settled, timed out or was cancelled. */
  done: Promise<RawTrace>;
  cancel(): void;
}

const RAW_TRACE_SCHEMA = 'motion-probe/raw-trace@1';

export function startRecording(targets: string[], options: RecordOptions = {}): Recording {
  const native = MotionProbeNative;
  if (!native) {
    const error = new Error('[motion-probe] native module is not linked. Expo Go is not supported; use a development build.');
    return { armed: Promise.reject(error), done: Promise.reject(error), cancel: () => {} };
  }

  const idleMs = options.idleMs ?? 300;
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxDurationMs = options.maxDurationMs ?? 15000;
  const pollMs = options.pollMs ?? 100;

  const frameTimes: number[] = [];
  const samples: number[][] = [];
  let firstChangeMs: number | undefined;
  let lastChangeMs = 0;
  let cancelled = false;
  let finished = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  let resolveDone!: (trace: RawTrace) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<RawTrace>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const infoPromise = native.getInfo();
  let startedAt = Date.now();

  const absorb = (drain: NativeDrain) => {
    for (const t of drain.frameTimes) frameTimes.push(t);
    for (const row of drain.samples) {
      samples.push(row);
      // Rows at frame 0 are the baseline; anything later is a change (motion, mount or unmount).
      if (row[0] > 0) {
        const t = frameTimes[row[0]] ?? frameTimes[frameTimes.length - 1] ?? 0;
        if (firstChangeMs === undefined) firstChangeMs = t;
        lastChangeMs = Math.max(lastChangeMs, t);
      }
    }
  };

  const finish = async (reason: EndReason) => {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    try {
      const drain = await native.stop(reason);
      absorb(drain);
      const info = await infoPromise;
      const app: AppInfo = { platform: info.platform, osVersion: info.osVersion, deviceName: info.deviceName, name: options.appName };
      resolveDone({
        schema: RAW_TRACE_SCHEMA,
        platform: info.platform,
        app,
        startedAt,
        targets,
        columns: info.columns,
        frameTimes,
        samples,
        endReason: (drain.endReason as EndReason) || reason,
      });
    } catch (error) {
      rejectDone(error);
    }
  };

  const poll = async () => {
    if (busy || finished) return;
    busy = true;
    try {
      const drain = await native.drain();
      absorb(drain);
      const now = frameTimes[frameTimes.length - 1] ?? 0;
      if (cancelled) await finish('cancelled');
      else if (!drain.running) await finish((drain.endReason as EndReason) || 'maxDuration');
      else if (firstChangeMs === undefined && now >= timeoutMs) await finish('timeout');
      else if (firstChangeMs !== undefined && now - lastChangeMs >= idleMs) await finish('settled');
    } catch (error) {
      finished = true;
      if (timer) clearInterval(timer);
      rejectDone(error);
    } finally {
      busy = false;
    }
  };

  const armed = native
    .start(targets, { maxDurationMs, resolveEveryFrames: 6, occlusionGrid: options.occlusionGrid ?? 6 })
    .then((result) => {
      startedAt = result.startedAt;
      timer = setInterval(poll, pollMs);
      return result;
    });
  armed.catch(rejectDone);

  return {
    armed,
    done,
    cancel: () => {
      cancelled = true;
      if (!busy) void finish('cancelled');
    },
  };
}
