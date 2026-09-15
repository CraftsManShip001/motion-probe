import { RAW_TRACE_SCHEMA, SAMPLE_COLUMNS, type RawTrace } from '../src/index.js';

export interface ViewState {
  /** Untransformed window position (already shifted by scrolling). */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  translateX?: number;
  translateY?: number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  opacity?: number;
  effectiveOpacity?: number;
  visibleRatio?: number;
  occludedRatio?: number;
  scrollX?: number;
  scrollY?: number;
  contentOpacity?: number;
}

export interface SyntheticTarget {
  id: string;
  /** State at time `t` (ms), or null when the view is not on screen. */
  at: (t: number) => ViewState | null;
}

/**
 * Builds a trace the way the native recorder does: a timestamp for every display frame and a
 * sample row only when a target's values changed.
 */
export function synthesize(options: {
  targets: SyntheticTarget[];
  durationMs: number;
  fps?: number;
  /** Frames (by time) the display skipped, e.g. main-thread blocked. */
  skip?: (t: number) => boolean;
  touches?: RawTrace['touches'];
}): RawTrace {
  const interval = 1000 / (options.fps ?? 60);
  const frameTimes: number[] = [];
  for (let t = 0; t <= options.durationMs; t += interval) {
    if (!options.skip?.(t)) frameTimes.push(Math.round(t * 1000) / 1000);
  }

  const samples: number[][] = [];
  const last: Array<number[] | null> = options.targets.map(() => null);
  frameTimes.forEach((t, frame) => {
    options.targets.forEach((target, ti) => {
      const state = target.at(t);
      const width = state?.width ?? 100;
      const height = state?.height ?? 100;
      const tx = state?.translateX ?? 0;
      const ty = state?.translateY ?? 0;
      const row = state
        ? [
            frame,
            ti,
            1,
            (state.x ?? 0) + tx,
            (state.y ?? 0) + ty,
            width,
            height,
            width,
            height,
            tx,
            ty,
            state.scaleX ?? 1,
            state.scaleY ?? 1,
            state.rotation ?? 0,
            state.opacity ?? 1,
            state.effectiveOpacity ?? state.opacity ?? 1,
            state.visibleRatio ?? 1,
            state.occludedRatio ?? 0,
            state.scrollX ?? 0,
            state.scrollY ?? 0,
            state.contentOpacity ?? 1,
          ]
        : [frame, ti, 0, ...new Array(SAMPLE_COLUMNS.length - 3).fill(0)];
      const prev = last[ti];
      if (prev === null) {
        last[ti] = row;
        if (row[2] === 1) samples.push(row);
        return;
      }
      if (row.slice(2).some((v, i) => Math.abs(v - prev[i + 2]) > 0.001)) {
        samples.push(row);
        last[ti] = row;
      }
    });
  });

  return {
    schema: RAW_TRACE_SCHEMA,
    platform: 'ios',
    startedAt: 1_700_000_000_000,
    targets: options.targets.map((t) => t.id),
    columns: [...SAMPLE_COLUMNS],
    frameTimes,
    samples,
    endReason: 'settled',
    ...(options.touches && { touches: options.touches }),
  };
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Value of a timing animation from `from` to `to` starting at `start` for `duration` ms. */
export function timing(t: number, start: number, duration: number, from: number, to: number, ease: (u: number) => number) {
  return from + (to - from) * ease(clamp01((t - start) / duration));
}

/** Underdamped spring step response. */
export function spring(t: number, start: number, from: number, to: number, zeta: number, omega: number) {
  if (t <= start) return from;
  const s = (t - start) / 1000;
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const env = Math.exp(-zeta * omega * s);
  const x = env * (Math.cos(wd * s) + ((zeta * omega) / wd) * Math.sin(wd * s));
  const value = to + (from - to) * x;
  // Springs come to rest once the displacement is negligible (like Reanimated's rest threshold).
  return Math.abs(value - to) < Math.abs(to - from) * 0.002 ? to : value;
}
