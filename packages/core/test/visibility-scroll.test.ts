import { describe, expect, it } from 'vitest';
import { NAMED_EASINGS, evaluate, formatReport, summarize } from '../src/index.js';
import { clamp01, synthesize, timing } from './synthetic.js';

const cubicOut = NAMED_EASINGS['cubic-out'].fn;

describe('occlusion', () => {
  const trace = synthesize({
    durationMs: 700,
    targets: [
      {
        id: 'badge',
        at: (t) => {
          const tx = timing(t, 0, 300, 0, 260, cubicOut);
          // A tooltip painted above the badge's final position covers its right side.
          return { translateX: tx, width: 44, height: 44, occludedRatio: clamp01((tx - 220) / 44) };
        },
      },
    ],
  });
  const report = summarize(trace);
  const badge = report.targets[0];

  it('separates covered area from clipping', () => {
    const v = badge.visibility!;
    expect(v.finalClipRatio).toBe(1);
    expect(v.finalOccludedRatio).toBeCloseTo(0.909, 2);
    expect(v.finalRatio).toBeCloseTo(0.091, 2);
    expect(v.clipped).toEqual([]);
    expect(v.occluded).toHaveLength(1);
    expect(v.hidden).toHaveLength(1);
  });

  it('reports occluded-at-end, not clipped-at-end', () => {
    const codes = report.issues.map((i) => i.code);
    expect(codes).toContain('occluded-at-end');
    expect(codes).not.toContain('clipped-at-end');
    expect(formatReport(report)).toMatch(/⚠ covered .*\(max 91%\)/);
  });

  it('fails visibility expectations with the cause in the message', () => {
    const result = evaluate(report, {
      expectations: [
        { target: 'badge', minFinalVisibleRatio: 0.99 },
        { target: 'badge', maxFinalOccludedRatio: 0.1 },
      ],
    });
    const messages = result.results.flatMap((r) => r.failures.map((f) => f.message));
    expect(messages[0]).toMatch(/ends 9% visible.*91% of the rest covered/);
    expect(messages[1]).toMatch(/91% covered by other views/);
  });
});

describe('scrolling', () => {
  // Item at content y=600 inside a scroll view; the view scrolls by 400.
  const item = (contentY: number) => (t: number) => {
    const scrollY = timing(t, 50, 300, 0, 400, cubicOut);
    const y = contentY - scrollY;
    return { y, height: 44, scrollY, visibleRatio: clamp01((500 - y) / 44) * clamp01((y + 44) / 44) };
  };

  it('reports scroll motion instead of layout movement', () => {
    const report = summarize(synthesize({ durationMs: 800, targets: [{ id: 'row', at: item(600) }] }));
    const props = report.targets[0].segments.map((s) => s.prop);
    expect(props).toEqual(['scrollY']);
    const scroll = report.targets[0].segments[0];
    expect(scroll.to).toBe(400);
    expect(scroll.easing?.name).toBe('cubic-out');
    expect(report.targets[0].final?.scrollY).toBe(400);
  });

  it('treats ending outside the viewport after a scroll as info, not a clipping bug', () => {
    const report = summarize(synthesize({ durationMs: 800, targets: [{ id: 'header', at: item(100) }] }));
    const issues = report.issues.filter((i) => i.target === 'header');
    expect(issues.map((i) => `${i.severity}:${i.code}`)).toEqual(['info:scrolled-out-of-view']);
  });
});

describe('older traces', () => {
  it('analyzes traces recorded without occlusion and scroll columns', () => {
    const trace = synthesize({
      durationMs: 500,
      targets: [{ id: 'card', at: (t) => ({ translateY: timing(t, 0, 300, 0, -120, cubicOut) }) }],
    });
    const legacy = { ...trace, columns: trace.columns.slice(0, 17), samples: trace.samples.map((row) => row.slice(0, 17)) };
    const report = summarize(legacy);
    expect(report.targets[0].segments.map((s) => s.prop)).toEqual(['translateY']);
    expect(report.targets[0].visibility?.finalOccludedRatio).toBe(0);
    expect(report.issues).toEqual([]);
  });
});
