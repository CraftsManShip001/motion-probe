import { describe, expect, it } from 'vitest';
import { NAMED_EASINGS, createBaselineSpec, evaluate, formatReport, summarize } from '../src/index.js';
import { spring, synthesize, timing } from './synthetic.js';

const cubicOut = NAMED_EASINGS['cubic-out'].fn;
const linear = NAMED_EASINGS.linear.fn;

function recording(options: { cardDuration?: number; toastEnd?: number; stall?: boolean } = {}) {
  return summarize(
    synthesize({
      durationMs: 1500,
      targets: [
        { id: 'card', at: (t) => ({ translateY: timing(t, 0, options.cardDuration ?? 300, 0, -120, cubicOut) }) },
        { id: 'badge', at: (t) => ({ scaleX: spring(t, 0, 1, 1.25, 0.3, 20) }) },
        {
          id: 'toast',
          at: (t) => {
            const ty = timing(t, 0, 300, 80, options.toastEnd ?? 20, cubicOut);
            return { translateY: ty, height: 56, visibleRatio: Math.max(0, Math.min(1, (60 - ty) / 56)) };
          },
        },
        {
          id: 'box',
          at: (t) => {
            const effective = options.stall && t >= 150 && t < 350 ? 150 : options.stall && t >= 350 ? t - 200 : t;
            return { translateX: timing(effective, 0, 400, 0, 200, linear) };
          },
        },
        { id: 'ghost', at: () => null },
      ],
    }),
  );
}

describe('detectIssues', () => {
  it('flags clipped endings, stalls and missing targets without a spec', () => {
    const report = recording({ stall: true });
    const codes = report.issues.map((i) => `${i.code}:${i.target}`);
    expect(codes).toContain('clipped-at-end:toast');
    expect(codes).toContain('stall:box');
    expect(codes).toContain('target-not-found:ghost');
    expect(codes.some((c) => c.endsWith(':card'))).toBe(false);
    expect(formatReport(report)).toMatch(/issues: .*clipped-at-end\(toast\)/);
  });

  it('is quiet for a clean recording', () => {
    const report = recording({ toastEnd: 4 });
    expect(report.issues.filter((i) => i.severity !== 'info' && i.target !== 'ghost')).toEqual([]);
  });
});

describe('createBaselineSpec', () => {
  it('produces a spec the source recording passes', () => {
    const report = recording();
    const spec = createBaselineSpec(report);
    const result = evaluate(report, spec);
    expect(result.results.filter((r) => !r.pass)).toEqual([]);
    expect(spec.expectations.some((e) => e.target === 'ghost')).toBe(false);
    expect(spec.expectations.find((e) => e.target === 'card' && e.prop === 'translateY')?.easing).toBe('cubic-out');
  });

  it('catches regressions against the baseline', () => {
    const spec = createBaselineSpec(recording());
    const regressed = evaluate(recording({ cardDuration: 450, stall: true }), spec);
    const failed = regressed.results.filter((r) => !r.pass).map((r) => `${r.target}.${r.prop}`);
    expect(failed).toContain('card.translateY');
    expect(failed).toContain('box.translateX');
  });
});
