import { SPEC_SCHEMA, type Expectation, type MotionSpec } from './assert.js';
import type { MotionReport } from './schema.js';

export interface BaselineOptions {
  /** Relative tolerance for durations. Default 15%. */
  timingTolerancePct?: number;
  /** Absolute floor for timing tolerances. Default two frames (min 34ms). */
  minTimingToleranceMs?: number;
  description?: string;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Turns an observed report into a spec, so a known-good recording becomes a motion regression test
 * ("golden" animations): later recordings fail when duration, curve, overshoot, stalls or final
 * visibility drift.
 */
export function createBaselineSpec(report: MotionReport, options: BaselineOptions = {}): MotionSpec {
  const relative = (options.timingTolerancePct ?? 15) / 100;
  const floor = options.minTimingToleranceMs ?? Math.max(34, 2 * report.frames.nominalIntervalMs);
  const timing = (value: number) => ({ value, tolerance: Math.round(Math.max(floor, value * relative)) });

  const expectations: Expectation[] = [];
  for (const target of report.targets) {
    if (!target.found) continue;
    if (!target.segments.length) expectations.push({ target: target.id, shouldMove: false });

    for (const s of target.segments) {
      const expectation: Expectation = { target: target.id, prop: s.prop, from: s.from, to: s.to };
      if (s.kind === 'animation') {
        expectation.durationMs = timing(s.durationMs);
        expectation.maxStalls = s.stalls.length;
        if (s.easing) {
          const named = s.easing.rmse <= 0.02;
          expectation.easing = named ? s.easing.name : s.easing.bezier;
          expectation.maxEasingRmse = Math.max(0.04, round3(2 * (named ? s.easing.rmse : s.easing.bezierRmse)));
          expectation.maxOvershootPct = 2;
        } else if (s.spring) {
          expectation.maxOvershootPct = Math.ceil(s.overshootPct * 1.2 + 2);
          expectation.settleMs = timing(s.settleMs);
        }
      }
      expectations.push(expectation);
    }

    const v = target.visibility;
    if (v && v.finalEffectiveOpacity > 0.01) {
      expectations.push({ target: target.id, minFinalVisibleRatio: Math.max(0, Math.floor((v.finalRatio - 0.01) * 100) / 100) });
    }
  }

  return {
    schema: SPEC_SCHEMA,
    meta: { source: 'baseline', generatedAt: new Date().toISOString(), description: options.description },
    expectations,
  };
}
