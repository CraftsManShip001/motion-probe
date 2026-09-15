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

  it('does not warn about intended endings: dismissed off screen, a backdrop under a sheet', () => {
    const report = summarize(
      synthesize({
        durationMs: 800,
        targets: [
          {
            id: 'sheet',
            at: (t) => {
              const ty = timing(t, 0, 250, 0, 320, cubicOut);
              return { translateY: ty, height: 320, visibleRatio: Math.max(0, Math.min(1, (320 - ty) / 320)) };
            },
          },
          { id: 'backdrop', at: (t) => ({ opacity: timing(t, 0, 300, 0, 0.5, linear), occludedRatio: 0.5 }) },
          { id: 'toast', at: (t) => ({ translateY: timing(t, 0, 250, -120, 0, cubicOut), occludedRatio: t > 100 ? 0.83 : 0 }) },
          { id: 'fader', at: (t) => ({ opacity: timing(t, 0, 200, 1, 0, linear) }) },
        ],
      }),
    );
    const issues = report.issues.map((i) => `${i.severity}:${i.code}:${i.target}`);
    expect(issues).toContain('info:offscreen-at-end:sheet');
    expect(issues).toContain('info:covered-at-end:backdrop');
    expect(issues).toContain('warning:occluded-at-end:toast');
    expect(issues).toContain('info:invisible-at-end:fader');

    const text = formatReport(report);
    expect(text).toMatch(/^issues: occluded-at-end\(toast\)$/m);
    expect(text).toMatch(/^■ sheet$/m);
    expect(text).toMatch(/^■ toast ⚠$/m);
    expect(text).toMatch(/⚠ covered .*\(max 83%\)/);
    expect(text).toMatch(/final transparent/);
  });

  it('does not judge the end state of a view that was removed during the recording', () => {
    const report = summarize(
      synthesize({
        durationMs: 800,
        targets: [
          {
            id: 'leaving',
            // An exiting list item: slides and fades out, is overlapped by the next item, then unmounts.
            at: (t) =>
              t > 300
                ? null
                : { translateX: timing(t, 0, 290, 0, -25, linear), opacity: timing(t, 0, 290, 1, 0.02, linear), visibleRatio: 0.98, occludedRatio: 0.5 },
          },
        ],
      }),
    );
    expect(report.issues.map((i) => `${i.severity}:${i.code}`)).toEqual(['info:unmounted']);
    expect(formatReport(report)).not.toMatch(/issues:/);
    expect(createBaselineSpec(report).expectations.some((e) => e.minFinalVisibleRatio !== undefined)).toBe(false);
  });

  it('does not count a zero-size view as clipped', () => {
    const report = summarize(
      synthesize({
        durationMs: 600,
        targets: [
          {
            id: 'accordion',
            at: (t) => {
              const h = timing(t, 20, 250, 0, 120, linear);
              return { height: h, visibleRatio: h > 0 ? 1 : 0 };
            },
          },
        ],
      }),
    );
    const accordion = report.targets[0];
    expect(accordion.visibility!.clipped).toEqual([]);
    expect(accordion.visibility!.minRatio).toBe(1);
    expect(formatReport(report)).toMatch(/^■ accordion$/m);
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
    expect(spec.expectations.find((e) => e.target === 'card' && e.prop === 'translateY')?.maxDroppedFrames).toBe(2);
  });

  it('catches regressions against the baseline', () => {
    const spec = createBaselineSpec(recording());
    const regressed = evaluate(recording({ cardDuration: 450, stall: true }), spec);
    const failed = regressed.results.filter((r) => !r.pass).map((r) => `${r.target}.${r.prop}`);
    expect(failed).toContain('card.translateY');
    expect(failed).toContain('box.translateX');
  });
});
