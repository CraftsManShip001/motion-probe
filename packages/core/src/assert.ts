import { NAMED_EASINGS, resolveEasing, rmse } from './easing.js';
import { segmentCurves } from './summarize.js';
import type { Bezier, Interval, MotionProp, MotionReport, Segment, TargetReport } from './schema.js';

export const SPEC_SCHEMA = 'motion-probe/spec@1' as const;
export const ASSERTIONS_SCHEMA = 'motion-probe/assertions@1' as const;

/** A bare number uses a default tolerance; `{ value, tolerance }` or `{ min, max }` are explicit. */
export type NumberExpectation = number | { value: number; tolerance: number } | { min?: number; max?: number };

export interface Expectation {
  target: string;
  /** Omit for target-level checks (visibility, dropped frames, "did it move at all"). */
  prop?: MotionProp;
  from?: number;
  to?: number;
  /** Tolerance for `from` / `to`. */
  tolerance?: number;
  startMs?: NumberExpectation;
  durationMs?: NumberExpectation;
  settleMs?: NumberExpectation;
  maxOvershootPct?: number;
  /** For springs that are supposed to bounce. */
  minOvershootPct?: number;
  monotonic?: boolean;
  /** Named curve (see NAMED_EASINGS) or cubic-bezier control points. */
  easing?: string | Bezier;
  maxEasingRmse?: number;
  maxStalls?: number;
  maxDroppedFrames?: number;
  /** Minimum effectively visible share while moving (not clipped and not covered). */
  minVisibleRatio?: number;
  /** Minimum effectively visible share at the end (not clipped and not covered). */
  minFinalVisibleRatio?: number;
  /** Maximum share covered by other views at the end. */
  maxFinalOccludedRatio?: number;
  shouldMove?: boolean;
  /** Defaults to true. */
  mustBeFound?: boolean;
}

export interface MotionSpec {
  schema?: typeof SPEC_SCHEMA;
  meta?: { source?: string; generatedAt?: string; description?: string };
  expectations: Expectation[];
}

export interface CheckFailure {
  check: string;
  expected: unknown;
  actual: unknown;
  message: string;
}

export interface ExpectationResult {
  index: number;
  target: string;
  prop?: MotionProp;
  pass: boolean;
  failures: CheckFailure[];
}

export interface AssertionReport {
  schema: typeof ASSERTIONS_SCHEMA;
  pass: boolean;
  passed: number;
  failed: number;
  results: ExpectationResult[];
}

const VALUE_TOLERANCE: Record<MotionProp, number> = {
  translateX: 2,
  translateY: 2,
  left: 2,
  top: 2,
  boundsWidth: 2,
  boundsHeight: 2,
  scrollX: 2,
  scrollY: 2,
  scaleX: 0.01,
  scaleY: 0.01,
  rotation: 1,
  opacity: 0.02,
};

const pct = (r: number) => `${Math.round(r * 100)}%`;

function describeExpectation(e: NumberExpectation, defaultTolerance: number): string {
  if (typeof e === 'number') return `${e}±${Math.round(defaultTolerance)}`;
  if ('value' in e) return `${e.value}±${e.tolerance}`;
  return [e.min !== undefined ? `≥${e.min}` : '', e.max !== undefined ? `≤${e.max}` : ''].filter(Boolean).join(' ');
}

function matches(e: NumberExpectation, actual: number, defaultTolerance: number): boolean {
  if (typeof e === 'number') return Math.abs(actual - e) <= defaultTolerance;
  if ('value' in e) return Math.abs(actual - e.value) <= e.tolerance;
  return (e.min === undefined || actual >= e.min) && (e.max === undefined || actual <= e.max);
}

/** Closest segment by from/to when given, else the largest one; animations win ties over jumps. */
function pickSegment(candidates: Segment[], exp: Expectation): Segment | undefined {
  const byValue = exp.from !== undefined || exp.to !== undefined;
  const score = (s: Segment) =>
    byValue
      ? (exp.from !== undefined ? Math.abs(s.from - exp.from) : 0) + (exp.to !== undefined ? Math.abs(s.to - exp.to) : 0)
      : -Math.abs(s.to - s.from);
  return [...candidates].sort(
    (a, b) => score(a) - score(b) || Number(a.kind !== 'animation') - Number(b.kind !== 'animation'),
  )[0];
}

function minVisibleDuring(target: TargetReport, window: Interval | undefined): number {
  if (!target.visibility) return 0;
  if (!window) return target.visibility.minRatio;
  let min = 1;
  for (const h of target.visibility.hidden) {
    if (h.endMs >= window.startMs && h.startMs <= window.endMs) min = Math.min(min, h.minRatio);
  }
  return min;
}

function evaluateOne(report: MotionReport, exp: Expectation, index: number): ExpectationResult {
  const failures: CheckFailure[] = [];
  const fail = (check: string, expected: unknown, actual: unknown, message: string) =>
    failures.push({ check, expected, actual, message });
  const result = () => ({ index, target: exp.target, prop: exp.prop, pass: failures.length === 0, failures });

  const target = report.targets.find((t) => t.id === exp.target);
  if (!target?.found) {
    if (exp.mustBeFound !== false) {
      fail('found', true, false, `"${exp.target}" was never on screen (testID missing, or view flattened?)`);
    }
    return result();
  }

  const frameMs = report.frames.nominalIntervalMs;
  let window: Interval | undefined = target.motion;

  if (exp.prop) {
    const prop = exp.prop;
    const candidates = target.segments.filter((s) => s.prop === prop);
    if (exp.shouldMove === false) {
      if (candidates.length) fail('shouldMove', false, true, `${prop} changed ${candidates.length} time(s)`);
      return result();
    }
    const seg = pickSegment(candidates, exp);
    if (!seg) {
      fail('moved', true, false, `${prop} never changed`);
      return result();
    }
    window = seg;

    const tol = exp.tolerance ?? VALUE_TOLERANCE[prop];
    if (exp.from !== undefined && Math.abs(seg.from - exp.from) > tol) {
      fail('from', exp.from, seg.from, `${prop} started at ${seg.from}, expected ${exp.from}±${tol}`);
    }
    if (exp.to !== undefined && Math.abs(seg.to - exp.to) > tol) {
      fail('to', exp.to, seg.to, `${prop} ended at ${seg.to}, expected ${exp.to}±${tol}`);
    }
    const timing: Array<[string, NumberExpectation | undefined, number]> = [
      ['startMs', exp.startMs, seg.startMs],
      ['durationMs', exp.durationMs, seg.durationMs],
      ['settleMs', exp.settleMs, seg.settleMs],
    ];
    for (const [check, expected, actual] of timing) {
      if (expected === undefined) continue;
      const defaultTolerance = Math.max(2 * frameMs, typeof expected === 'number' ? expected * 0.1 : 0);
      if (!matches(expected, actual, defaultTolerance)) {
        fail(check, expected, actual, `${prop} ${check} was ${actual}ms, expected ${describeExpectation(expected, defaultTolerance)}ms`);
      }
    }
    if (seg.kind === 'jump' && (exp.durationMs !== undefined || exp.easing !== undefined)) {
      fail('kind', 'animation', 'jump', `${prop} jumped ${seg.from} → ${seg.to} within one frame instead of animating`);
    }
    if (exp.maxOvershootPct !== undefined && seg.overshootPct > exp.maxOvershootPct) {
      fail('maxOvershootPct', exp.maxOvershootPct, seg.overshootPct, `${prop} overshot by ${seg.overshootPct}% (max ${exp.maxOvershootPct}%)`);
    }
    if (exp.minOvershootPct !== undefined && seg.overshootPct < exp.minOvershootPct) {
      fail('minOvershootPct', exp.minOvershootPct, seg.overshootPct, `${prop} overshoot ${seg.overshootPct}% is below ${exp.minOvershootPct}% (expected a bouncier spring)`);
    }
    if (exp.monotonic && !seg.monotonic) {
      fail('monotonic', true, false, `${prop} reversed direction while animating`);
    }
    if (exp.easing !== undefined && seg.kind === 'animation') {
      const fn = resolveEasing(exp.easing);
      const points = segmentCurves.get(seg);
      if (!fn) {
        fail('easing', exp.easing, 'unknown', `unknown easing "${exp.easing}" (known: ${Object.keys(NAMED_EASINGS).join(', ')})`);
      } else if (!points) {
        fail('easing', exp.easing, 'none', `${prop} has no progress curve to compare`);
      } else {
        const err = Math.round(rmse(points, fn) * 1000) / 1000;
        const max = exp.maxEasingRmse ?? 0.04;
        if (err > max) {
          const closest = seg.easing
            ? `closest: ${seg.easing.name}, fitted cubic-bezier(${seg.easing.bezier.join(', ')})`
            : seg.spring
              ? `observed a spring (overshoot ${seg.overshootPct}%)`
              : '';
          fail('easing', exp.easing, seg.easing?.name ?? 'spring', `${prop} curve differs from ${JSON.stringify(exp.easing)} (rmse ${err} > ${max}); ${closest}`);
        }
      }
    }
    if (exp.maxStalls !== undefined && seg.stalls.length > exp.maxStalls) {
      const worst = Math.max(...seg.stalls.map((s) => s.durationMs));
      fail('maxStalls', exp.maxStalls, seg.stalls.length, `${prop} froze ${seg.stalls.length} time(s) mid-animation (worst ${worst}ms)`);
    }
    if (exp.maxDroppedFrames !== undefined && seg.droppedFrames > exp.maxDroppedFrames) {
      fail('maxDroppedFrames', exp.maxDroppedFrames, seg.droppedFrames, `${seg.droppedFrames} display frames dropped during ${prop} animation`);
    }
  } else {
    if (exp.shouldMove === false && target.segments.length) {
      fail('shouldMove', false, true, `"${exp.target}" moved (${target.segments.map((s) => s.prop).join(', ')})`);
    }
    if (exp.shouldMove === true && !target.segments.length) {
      fail('shouldMove', true, false, `"${exp.target}" did not move`);
    }
    if (exp.maxDroppedFrames !== undefined && window) {
      const dropped = report.frames.jank
        .filter((j) => j.endMs >= window!.startMs && j.startMs <= window!.endMs)
        .reduce((sum, j) => sum + j.droppedFrames, 0);
      if (dropped > exp.maxDroppedFrames) {
        fail('maxDroppedFrames', exp.maxDroppedFrames, dropped, `${dropped} display frames dropped while "${exp.target}" was moving`);
      }
    }
  }

  const v = target.visibility;
  if (exp.minVisibleRatio !== undefined) {
    const min = minVisibleDuring(target, window);
    if (min < exp.minVisibleRatio) {
      fail('minVisibleRatio', exp.minVisibleRatio, min, `"${exp.target}" was only ${pct(min)} visible while moving (clipped or covered)`);
    }
  }
  if (exp.minFinalVisibleRatio !== undefined && v && v.finalRatio < exp.minFinalVisibleRatio) {
    const causes = [
      v.finalClipRatio < 0.99 ? `${pct(1 - v.finalClipRatio)} clipped` : '',
      v.finalOccludedRatio > 0.01 ? `${pct(v.finalOccludedRatio)} of the rest covered` : '',
    ].filter(Boolean);
    fail(
      'minFinalVisibleRatio',
      exp.minFinalVisibleRatio,
      v.finalRatio,
      `"${exp.target}" ends ${pct(v.finalRatio)} visible (expected ≥ ${pct(exp.minFinalVisibleRatio)})${causes.length ? `: ${causes.join(', ')}` : ''}`,
    );
  }
  if (exp.maxFinalOccludedRatio !== undefined && v && v.finalOccludedRatio > exp.maxFinalOccludedRatio) {
    fail(
      'maxFinalOccludedRatio',
      exp.maxFinalOccludedRatio,
      v.finalOccludedRatio,
      `"${exp.target}" ends ${pct(v.finalOccludedRatio)} covered by other views (max ${pct(exp.maxFinalOccludedRatio)})`,
    );
  }
  return result();
}

export function evaluate(report: MotionReport, spec: MotionSpec): AssertionReport {
  const results = spec.expectations.map((exp, i) => evaluateOne(report, exp, i));
  const failed = results.filter((r) => !r.pass).length;
  return { schema: ASSERTIONS_SCHEMA, pass: failed === 0, passed: results.length - failed, failed, results };
}
