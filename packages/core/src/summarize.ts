import { NAMED_EASINGS, fitEasing, rmse, type CurvePoint } from './easing.js';
import { detectIssues } from './issues.js';
import {
  DEFAULT_EPSILON,
  MOTION_PROPS,
  REPORT_SCHEMA,
  SAMPLE_COLUMNS,
  type Bezier,
  type FinalState,
  type FrameStats,
  type Interval,
  type JankInterval,
  type MotionProp,
  type MotionReport,
  type OccludedInterval,
  type RatioInterval,
  type RawTrace,
  type Segment,
  type SegmentLoop,
  type SpringFit,
  type Stall,
  type TargetReport,
  type TouchInterval,
  type Visibility,
} from './schema.js';

/** Finger travel (points / dp) that makes a touch a drag rather than a press. */
const DRAG_SLOP = 10;

export interface SummarizeOptions {
  /** Unchanged time that splits two segments of the same prop. */
  gapMs?: number;
  epsilon?: Partial<Record<MotionProp, number>>;
}

/** Normalized progress curve per segment, kept out of the JSON report but available to assertions. */
export const segmentCurves = new WeakMap<Segment, CurvePoint[]>();

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};
const ms = (v: number) => round(v, 1);
const ratio = (v: number) => round(v, 3);
const RATIO_PROPS = new Set<MotionProp>(['opacity', 'inheritedOpacity', 'contentOpacity', 'scaleX', 'scaleY']);
const value = (prop: MotionProp, v: number) => (RATIO_PROPS.has(prop) ? round(v, 3) : round(v, 2));

type Column = SampleColumn | 'left' | 'top' | 'inheritedOpacity';
type SampleColumn = (typeof SAMPLE_COLUMNS)[number];

interface TargetSeries {
  present: Uint8Array;
  cols: Record<Column, Float64Array>;
}

/** Expands change-only rows into per-frame, step-held series. */
function reconstruct(trace: RawTrace): TargetSeries[] {
  const n = trace.frameTimes.length;
  const index = new Map(trace.columns.map((c, i) => [c, i]));
  const frameCol = index.get('frame') ?? 0;
  const targetCol = index.get('target') ?? 1;
  const presentCol = index.get('present') ?? 2;

  const rowsByTarget = trace.targets.map(() => [] as number[][]);
  for (const row of trace.samples) rowsByTarget[row[targetCol]]?.push(row);

  return rowsByTarget.map((rows) => {
    rows.sort((a, b) => a[frameCol] - b[frameCol]);
    const present = new Uint8Array(n);
    const cols = {} as Record<Column, Float64Array>;
    for (const c of [...SAMPLE_COLUMNS, 'left', 'top', 'inheritedOpacity'] as Column[]) cols[c] = new Float64Array(n);

    let current: number[] | undefined;
    let k = 0;
    for (let f = 0; f < n; f++) {
      while (k < rows.length && rows[k][frameCol] <= f) current = rows[k++];
      if (!current || current[presentCol] !== 1) continue;
      present[f] = 1;
      for (const c of SAMPLE_COLUMNS) {
        const i = index.get(c);
        if (i !== undefined) cols[c][f] = current[i] ?? 0;
      }
      // Layout position: window center minus own transform, plus scroll offset (content coordinates).
      cols.left[f] = cols.x[f] + cols.width[f] / 2 - cols.translateX[f] - cols.boundsWidth[f] / 2 + cols.scrollX[f];
      cols.top[f] = cols.y[f] + cols.height[f] / 2 - cols.translateY[f] - cols.boundsHeight[f] / 2 + cols.scrollY[f];
      // Ancestors' share of the effective opacity; undefined while the view itself is transparent,
      // so it holds the last known value.
      const own = cols.opacity[f];
      cols.inheritedOpacity[f] =
        own > 0.001 ? Math.min(1, cols.effectiveOpacity[f] / own) : f > 0 && present[f - 1] ? cols.inheritedOpacity[f - 1] : 1;
    }
    unwrapDegrees(cols.rotation, present);
    return { present, cols };
  });
}

/**
 * Rotation arrives modulo a turn (iOS derives it with atan2 in (-180°, 180°]; a repeating animation
 * resets Android's value from 360° to 0°). Unwrap it so a spinner reads as one continuous rotation
 * instead of a jump every turn.
 */
function unwrapDegrees(v: Float64Array, present: Uint8Array) {
  let offset = 0;
  let prev: number | undefined;
  for (let f = 0; f < v.length; f++) {
    if (!present[f]) {
      prev = undefined;
      offset = 0;
      continue;
    }
    const raw = v[f];
    if (prev !== undefined) {
      if (raw - prev > 180) offset -= 360;
      else if (raw - prev < -180) offset += 360;
    }
    prev = raw;
    v[f] = raw + offset;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const missedFrames = (gapMs: number, nominal: number) =>
  gapMs > nominal * 1.5 ? Math.max(1, Math.round(gapMs / nominal) - 1) : 0;

export function frameStats(times: number[]): FrameStats {
  const deltas: number[] = [];
  for (let i = 1; i < times.length; i++) deltas.push(times[i] - times[i - 1]);
  const nominal = deltas.length ? median(deltas) : 1000 / 60;

  let dropped = 0;
  let worst = 0;
  const jank: JankInterval[] = [];
  for (let i = 1; i < times.length; i++) {
    const gap = times[i] - times[i - 1];
    worst = Math.max(worst, gap);
    const missed = missedFrames(gap, nominal);
    if (!missed) continue;
    dropped += missed;
    const last = jank.at(-1);
    if (last && last.endMs === times[i - 1]) {
      last.endMs = times[i];
      last.droppedFrames += missed;
    } else {
      jank.push({ startMs: times[i - 1], endMs: times[i], droppedFrames: missed });
    }
  }

  return {
    count: times.length,
    nominalIntervalMs: round(nominal, 2),
    fps: Math.round(1000 / nominal),
    droppedFrames: dropped,
    worstGapMs: ms(worst),
    jank: jank.map((j) => ({ ...j, startMs: ms(j.startMs), endMs: ms(j.endMs) })),
  };
}

function presenceRuns(present: Uint8Array): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let f = 0; f < present.length; f++) {
    if (present[f] && start < 0) start = f;
    if (!present[f] && start >= 0) {
      runs.push([start, f - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, present.length - 1]);
  return runs;
}

/** Splits frame ranges at the first frame at or after each boundary time; pieces share that frame. */
function splitAt(runs: Array<[number, number]>, boundaries: number[], times: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of runs) {
    let start = a;
    for (const boundary of [...boundaries].sort((x, y) => x - y)) {
      const k = times.findIndex((t, f) => f > start && f < b && t >= boundary && times[f - 1] < boundary);
      if (k < 0) continue;
      out.push([start, k]);
      start = k;
    }
    out.push([start, b]);
  }
  return out;
}

function fitSpring(v: Float64Array, s0: number, e: number, to: number, delta: number, times: number[]): SpringFit {
  const abs = Math.abs(delta);
  const band = abs * 0.005;
  // Peak |deviation from `to`| per half-wave; the approach from `from` is the first half-wave.
  const peaks: Array<{ amp: number; t: number }> = [];
  let sign = 0;
  for (let i = s0; i <= e; i++) {
    const d = v[i] - to;
    if (Math.abs(d) <= band) continue;
    const sg = Math.sign(d);
    if (sg !== sign) {
      peaks.push({ amp: Math.abs(d), t: times[i] });
      sign = sg;
    } else if (Math.abs(d) > peaks[peaks.length - 1].amp) {
      peaks[peaks.length - 1] = { amp: Math.abs(d), t: times[i] };
    }
  }
  if (peaks.length < 2) return {};

  const decrements: number[] = [];
  for (let k = 0; k + 1 < peaks.length && decrements.length < 3; k++) {
    if (peaks[k + 1].amp > band) decrements.push(Math.log(peaks[k].amp / peaks[k + 1].amp));
  }
  const fit: SpringFit = {};
  if (decrements.length) {
    const delta = decrements.reduce((a, b) => a + b, 0) / decrements.length;
    fit.dampingRatio = round(delta / Math.sqrt(Math.PI * Math.PI + delta * delta), 3);
  }
  if (peaks.length >= 3) {
    const halfPeriods: number[] = [];
    for (let k = 1; k + 1 < peaks.length; k++) halfPeriods.push(peaks[k + 1].t - peaks[k].t);
    fit.periodMs = ms((2 * halfPeriods.reduce((a, b) => a + b, 0)) / halfPeriods.length);
  }
  if (fit.dampingRatio !== undefined && fit.periodMs && fit.dampingRatio < 1) {
    // Equivalent spring at mass 1, so the fit can be compared with a damping/stiffness config.
    const zeta = fit.dampingRatio;
    const omega = (2 * Math.PI) / (fit.periodMs / 1000) / Math.sqrt(1 - zeta * zeta);
    fit.stiffness = Math.round(omega * omega);
    fit.damping = round(2 * zeta * omega, 1);
  }
  return fit;
}

/**
 * Damping ratios tried for springs that do not overshoot. A best fit on the last one is not reported:
 * a heavily overdamped curve is close to a plain exponential, where stiffness and damping trade off
 * and no single spring config describes it.
 */
const DAMPING_RATIOS = [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5];

/** Step response (0 → 1) of a spring with damping ratio ζ ≥ 1 and natural frequency ω (rad/s). */
function dampedStep(zeta: number, omega: number, s: number): number {
  if (zeta <= 1.0001) return 1 - (1 + omega * s) * Math.exp(-omega * s);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * (zeta - root);
  const r2 = -omega * (zeta + root);
  return 1 - (r2 * Math.exp(r1 * s) - r1 * Math.exp(r2 * s)) / (r2 - r1);
}

/**
 * Springs that do not overshoot (critically or over-damped, like Reanimated 4's default `withSpring`)
 * look like an ease-out but approach the target asymptotically. Fits ζ ≥ 1 and ω to the progress curve.
 */
function fitDampedSpring(points: CurvePoint[], durationMs: number): { zeta: number; omega: number; rmse: number } {
  let best = { zeta: 1, omega: 0, rmse: Infinity };
  const errorOf = (zeta: number, omega: number) => {
    let sum = 0;
    for (const { u, p } of points) sum += (dampedStep(zeta, omega, (u * durationMs) / 1000) - p) ** 2;
    return Math.sqrt(sum / points.length);
  };
  for (const zeta of DAMPING_RATIOS) {
    for (let omega = 2; omega <= 200; omega *= 1.04) {
      const rmse = errorOf(zeta, omega);
      if (rmse < best.rmse) best = { zeta, omega, rmse };
    }
  }
  return best;
}

/** Normalized progress of frames s0..e, with the motion starting at `t0` (≥ times[s0]). */
function curvePoints(v: Float64Array, s0: number, e: number, times: number[], t0: number): CurvePoint[] {
  const from = v[s0];
  const delta = v[e] - from;
  const duration = times[e] - t0;
  const points: CurvePoint[] = [{ u: 0, p: 0 }];
  for (let i = s0 + 1; i <= e; i++) points.push({ u: (times[i] - t0) / duration, p: (v[i] - from) / delta });
  return points;
}

/**
 * The last still frame only bounds the start from below. Drivers that start inside a frame callback
 * (Reanimated) render ~0% progress on their first frame, so taking that still frame as the start adds
 * a frame and makes the curve look slow to start. Picks the start between the still frame and the
 * first moving frame whose curve best matches a named easing; ties keep the frame time.
 */
function estimateStart(v: Float64Array, s0: number, e: number, times: number[]): number {
  const lo = times[s0];
  const step = (times[s0 + 1] - lo) / 16;
  let best = lo;
  let bestErr = Infinity;
  for (let k = 0; k < 16; k++) {
    const points = curvePoints(v, s0, e, times, lo + k * step);
    let err = Infinity;
    for (const { fn } of Object.values(NAMED_EASINGS)) err = Math.min(err, rmse(points, fn));
    if (err < bestErr - 1e-4) {
      bestErr = err;
      best = lo + k * step;
    }
  }
  return best;
}

function buildSegment(
  prop: MotionProp,
  v: Float64Array,
  s0: number,
  e: number,
  times: number[],
  nominal: number,
  eps: number,
  gesture: boolean,
): Segment | null {
  const tiny = eps * 0.05;
  const from = v[s0];
  const to = v[e];
  const delta = to - from;
  const abs = Math.abs(delta);

  let maxDeviation = 0;
  for (let i = s0; i <= e; i++) maxDeviation = Math.max(maxDeviation, Math.abs(v[i] - from));
  if (Math.max(abs, maxDeviation) < eps) return null;

  const startMs = times[s0];
  const endMs = times[e];
  const kind = e - s0 <= 1 ? 'jump' : 'animation';

  let overshoot = 0;
  let oscillations = 0;
  let monotonic = true;
  let settleIndex = e;
  if (abs >= eps) {
    const dir = Math.sign(delta);
    let sign = 0;
    for (let i = s0; i <= e; i++) {
      overshoot = Math.max(overshoot, (v[i] - to) * dir);
      if (i > s0 && (v[i] - v[i - 1]) * dir < -Math.max(tiny, abs * 0.001)) monotonic = false;
      const d = v[i] - to;
      if (Math.abs(d) > abs * 0.005) {
        const sg = Math.sign(d);
        if (sign !== 0 && sg !== sign) oscillations++;
        sign = sg;
      }
    }
    const band = Math.max(abs * 0.02, eps * 0.5);
    while (settleIndex > s0 && Math.abs(v[settleIndex - 1] - to) <= band) settleIndex--;
  } else {
    // Returns to where it started (pulse / shake): count direction reversals instead.
    monotonic = false;
    let dirSign = 0;
    for (let i = s0 + 1; i <= e; i++) {
      const step = v[i] - v[i - 1];
      if (Math.abs(step) <= tiny) continue;
      const sg = Math.sign(step);
      if (dirSign !== 0 && sg !== dirSign) oscillations++;
      dirSign = sg;
    }
  }

  // A finger resting mid-drag holds the value; that is not the animation freezing.
  const stalls: Stall[] = [];
  let heldFrom = -1;
  for (let i = s0 + 1; !gesture && i <= e; i++) {
    const moving = Math.abs(v[i] - v[i - 1]) > tiny;
    if (!moving) {
      if (heldFrom < 0) heldFrom = i;
      continue;
    }
    if (heldFrom >= 0) {
      const held = i - heldFrom;
      const remaining = abs >= eps ? Math.abs(to - v[i - 1]) / abs : 1;
      // A freeze continues in the same direction afterwards; a spring turning point reverses.
      const before = heldFrom - 2 >= s0 ? v[heldFrom - 1] - v[heldFrom - 2] : 0;
      const after = v[i] - v[i - 1];
      const sameDirection = Math.sign(before) === Math.sign(after);
      if (held >= 2 && remaining > 0.05 && sameDirection) {
        stalls.push({
          startMs: ms(times[heldFrom - 1]),
          endMs: ms(times[i]),
          durationMs: ms(times[i] - times[heldFrom - 1]),
          frames: held,
        });
      }
      heldFrom = -1;
    }
  }

  let droppedFrames = 0;
  for (let i = s0 + 1; i <= e; i++) droppedFrames += missedFrames(times[i] - times[i - 1], nominal);

  const overshootPct = abs >= eps ? (overshoot / abs) * 100 : 0;
  const animated = kind === 'animation' && !gesture;
  const loop = animated && oscillations >= 3 ? detectLoop(v, s0, e, times, prop) : undefined;
  const fitsEasing = animated && abs >= eps && overshootPct < 2 && !loop;
  const t0 = fitsEasing ? estimateStart(v, s0, e, times) : startMs;
  const segment: Segment = {
    prop,
    kind,
    from: value(prop, from),
    to: value(prop, to),
    startMs: ms(t0),
    endMs: ms(endMs),
    durationMs: ms(endMs - t0),
    settleMs: ms(times[settleIndex] - t0),
    monotonic,
    overshootPct: round(overshootPct, 1),
    oscillations,
    stalls,
    droppedFrames,
  };

  if (gesture) segment.gesture = true;
  if (animated && abs >= eps) {
    const points = curvePoints(v, s0, e, times, t0);
    segmentCurves.set(segment, points);
    if (fitsEasing) {
      const fit = fitEasing(points);
      segment.easing = {
        name: fit.name,
        rmse: ratio(fit.rmse),
        bezier: fit.bezier.map((b) => round(b, 3)) as unknown as Bezier,
        bezierRmse: ratio(fit.bezierRmse),
      };
      // A poor easing fit on a curve that never overshoots may be a critically / over-damped spring.
      if (fit.rmse > 0.02 && monotonic) {
        const damped = fitDampedSpring(points, endMs - t0);
        const atEdge = damped.zeta === DAMPING_RATIOS[DAMPING_RATIOS.length - 1];
        if (damped.rmse < 0.02 && damped.rmse < fit.rmse * 0.6 && !atEdge) {
          segment.spring = {
            dampingRatio: round(damped.zeta, 2),
            stiffness: Math.round(damped.omega ** 2),
            damping: round(2 * damped.zeta * damped.omega, 1),
          };
        }
      }
    } else if (!loop) {
      segment.spring = fitSpring(v, s0, e, to, delta, times);
    }
  }
  if (loop) segment.loop = loop;
  return segment;
}

/**
 * A sustained oscillation (a pulse, a breathing or shimmer loop) swings between extremes that do not
 * shrink. A spring oscillates too, but its swings decay quickly — fitting one to a loop yields
 * nonsense such as a negative damping ratio.
 */
function detectLoop(v: Float64Array, s0: number, e: number, times: number[], prop: MotionProp): SegmentLoop | undefined {
  const extrema: Array<{ v: number; t: number }> = [];
  let dir = 0;
  for (let i = s0 + 1; i <= e; i++) {
    const step = v[i] - v[i - 1];
    if (Math.abs(step) <= 1e-6) continue;
    const sg = Math.sign(step);
    if (dir !== 0 && sg !== dir) extrema.push({ v: v[i - 1], t: times[i - 1] });
    dir = sg;
  }
  if (extrema.length < 3) return undefined;
  const swings = extrema.slice(1).map((x, k) => Math.abs(x.v - extrema[k].v));
  if (swings[swings.length - 1] < 0.7 * swings[0]) return undefined;

  let min = Infinity;
  let max = -Infinity;
  for (let i = s0; i <= e; i++) {
    min = Math.min(min, v[i]);
    max = Math.max(max, v[i]);
  }
  const halfPeriods = extrema.slice(1).map((x, k) => x.t - extrema[k].t);
  const periodMs = (2 * halfPeriods.reduce((a, b) => a + b, 0)) / halfPeriods.length;
  return {
    min: value(prop, min),
    max: value(prop, max),
    periodMs: ms(periodMs),
    cycles: round((times[e] - times[s0]) / periodMs, 1),
  };
}

function detectSegments(
  prop: MotionProp,
  v: Float64Array,
  a: number,
  b: number,
  times: number[],
  nominal: number,
  gapMs: number,
  eps: number,
  dragging: (startMs: number, endMs: number) => boolean,
): Segment[] {
  const tiny = eps * 0.05;
  const out: Segment[] = [];
  let first = -1;
  let lastActive = -1;
  const flush = () => {
    if (first >= 0) {
      // Include the easing tail: consecutive frames that still change, even by less than `tiny`.
      let end = lastActive;
      while (end < b && Math.abs(v[end + 1] - v[end]) > 1e-6) end++;
      const gesture = dragging(times[first - 1], times[end]);
      const segment = buildSegment(prop, v, first - 1, end, times, nominal, eps, gesture);
      if (segment) out.push(segment);
    }
    first = -1;
  };
  for (let i = a + 1; i <= b; i++) {
    if (Math.abs(v[i] - v[i - 1]) <= tiny) continue;
    if (first >= 0 && times[i - 1] - times[lastActive] > gapMs) flush();
    if (first < 0) first = i;
    lastActive = i;
  }
  flush();
  return out;
}

/** Extends the open interval while `active`, closing it into `list` otherwise. */
function trackMin(list: RatioInterval[], open: RatioInterval | null, active: boolean, t: number, value: number) {
  if (!active) {
    if (open) list.push(open);
    return null;
  }
  if (!open) return { startMs: t, endMs: t, minRatio: value };
  open.endMs = t;
  open.minRatio = Math.min(open.minRatio, value);
  return open;
}

function trackMax(list: OccludedInterval[], open: OccludedInterval | null, active: boolean, t: number, value: number) {
  if (!active) {
    if (open) list.push(open);
    return null;
  }
  if (!open) return { startMs: t, endMs: t, maxRatio: value };
  open.endMs = t;
  open.maxRatio = Math.max(open.maxRatio, value);
  return open;
}

function analyzeVisibility(
  s: TargetSeries,
  runs: Array<[number, number]>,
  times: number[],
  motion: Interval | undefined,
): Visibility {
  const clipRatio = s.cols.visibleRatio;
  const covered = s.cols.occludedRatio;
  const opacity = s.cols.effectiveOpacity;
  const effective = (f: number) => clipRatio[f] * (1 - covered[f]);
  // A zero-size view (an accordion before it opens) has nothing to clip or cover.
  const hasArea = (f: number) => s.cols.width[f] * s.cols.height[f] >= 0.5;

  let min = 1;
  const hidden: RatioInterval[] = [];
  const clipped: RatioInterval[] = [];
  const occluded: OccludedInterval[] = [];
  for (const [a, b] of runs) {
    let openHidden: RatioInterval | null = null;
    let openClipped: RatioInterval | null = null;
    let openOccluded: OccludedInterval | null = null;
    for (let f = a; f <= b; f++) {
      const t = times[f];
      const shown = opacity[f] > 0.01 && hasArea(f);
      if (shown && (!motion || (t >= motion.startMs && t <= motion.endMs))) min = Math.min(min, effective(f));
      openHidden = trackMin(hidden, openHidden, shown && effective(f) < 0.99, t, effective(f));
      openClipped = trackMin(clipped, openClipped, shown && clipRatio[f] < 0.99, t, clipRatio[f]);
      openOccluded = trackMax(occluded, openOccluded, shown && covered[f] > 0.01, t, covered[f]);
    }
    if (openHidden) hidden.push(openHidden);
    if (openClipped) clipped.push(openClipped);
    if (openOccluded) occluded.push(openOccluded);
  }

  const last = runs[runs.length - 1][1];
  const roundMin = (i: RatioInterval) => ({ startMs: ms(i.startMs), endMs: ms(i.endMs), minRatio: ratio(i.minRatio) });
  return {
    minRatio: ratio(min),
    finalRatio: ratio(effective(last)),
    finalClipRatio: ratio(clipRatio[last]),
    finalOccludedRatio: ratio(covered[last]),
    finalEffectiveOpacity: ratio(opacity[last]),
    hidden: hidden.map(roundMin),
    clipped: clipped.map(roundMin),
    occluded: occluded.map((i) => ({ startMs: ms(i.startMs), endMs: ms(i.endMs), maxRatio: ratio(i.maxRatio) })),
  };
}

function analyzeTarget(
  id: string,
  s: TargetSeries,
  times: number[],
  nominal: number,
  gapMs: number,
  eps: Record<MotionProp, number>,
  touches: TouchInterval[],
): TargetReport {
  const runs = presenceRuns(s.present);
  if (runs.length === 0) return { id, found: false, presence: [], segments: [] };

  // A finger going down or lifting starts something new (a press animation, a release or fling), so
  // motion is split there; while a finger drags, the view follows it.
  const drags = touches.filter((t) => t.distance >= DRAG_SLOP);
  const dragging = (startMs: number, endMs: number) => {
    const mid = (startMs + endMs) / 2;
    return drags.some((t) => mid > t.startMs && mid < t.endMs);
  };
  const boundaries = touches.flatMap((t) => [t.startMs, t.endMs]);

  const segments: Segment[] = [];
  for (const [a, b] of splitAt(runs, boundaries, times)) {
    for (const prop of MOTION_PROPS) {
      for (const seg of detectSegments(prop, s.cols[prop], a, b, times, nominal, gapMs, eps[prop], dragging)) {
        // A view's content is drawn on its first frames on screen (iOS renders text a frame after the
        // view appears): that is the view mounting, not its content changing.
        const atMount = prop === 'contentOpacity' && seg.kind === 'jump' && seg.startMs <= times[a] + 2.5 * nominal;
        if (!atMount) segments.push(seg);
      }
    }
  }
  segments.sort((x, y) => x.startMs - y.startMs || MOTION_PROPS.indexOf(x.prop) - MOTION_PROPS.indexOf(y.prop));

  const motion = segments.length
    ? {
        startMs: Math.min(...segments.map((seg) => seg.startMs)),
        endMs: Math.max(...segments.map((seg) => seg.endMs)),
      }
    : undefined;

  const last = runs[runs.length - 1][1];
  const c = s.cols;
  const final: FinalState = {
    x: round(c.x[last], 2),
    y: round(c.y[last], 2),
    width: round(c.width[last], 2),
    height: round(c.height[last], 2),
    translateX: round(c.translateX[last], 2),
    translateY: round(c.translateY[last], 2),
    scaleX: round(c.scaleX[last], 3),
    scaleY: round(c.scaleY[last], 3),
    rotation: round(c.rotation[last], 2),
    opacity: round(c.opacity[last], 3),
    effectiveOpacity: round(c.effectiveOpacity[last], 3),
    visibleRatio: round(c.visibleRatio[last], 3),
    occludedRatio: round(c.occludedRatio[last], 3),
    scrollX: round(c.scrollX[last], 2),
    scrollY: round(c.scrollY[last], 2),
  };

  return {
    id,
    found: true,
    presence: runs.map(([a, b]) => ({ startMs: ms(times[a]), endMs: ms(times[b]) })),
    motion,
    segments,
    visibility: analyzeVisibility(s, runs, times, motion),
    final,
  };
}

export function summarize(trace: RawTrace, options: SummarizeOptions = {}): MotionReport {
  const times = trace.frameTimes;
  const frames = frameStats(times);
  const eps = { ...DEFAULT_EPSILON, ...options.epsilon };
  const gapMs = options.gapMs ?? 300;
  const series = reconstruct(trace);

  const report = {
    schema: REPORT_SCHEMA,
    platform: trace.platform,
    app: trace.app,
    startedAt: trace.startedAt,
    durationMs: ms(times.at(-1) ?? 0),
    endReason: trace.endReason,
    frames,
    targets: trace.targets.map((id, i) =>
      analyzeTarget(id, series[i], times, frames.nominalIntervalMs, gapMs, eps, trace.touches ?? []),
    ),
  };
  return { ...report, issues: detectIssues(report) };
}
