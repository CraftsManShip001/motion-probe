import { describe, expect, it } from 'vitest';
import { NAMED_EASINGS, evaluate, formatAssertions, summarize, toOtlpJson } from '../src/index.js';
import { spring, synthesize, timing } from './synthetic.js';

const cubicOut = NAMED_EASINGS['cubic-out'].fn;

const trace = synthesize({
  durationMs: 1500,
  targets: [
    { id: 'card', at: (t) => ({ translateY: timing(t, 0, 300, 0, -120, cubicOut) }) },
    { id: 'badge', at: (t) => ({ scaleX: spring(t, 0, 1, 1.25, 0.3, 20) }) },
    {
      id: 'toast',
      at: (t) => {
        const ty = timing(t, 0, 300, 80, 20, cubicOut);
        return { translateY: ty, height: 56, visibleRatio: Math.max(0, Math.min(1, (60 - ty) / 56)) };
      },
    },
  ],
});
const report = summarize(trace);

describe('evaluate', () => {
  it('passes when the observed motion matches the spec', () => {
    const result = evaluate(report, {
      expectations: [
        { target: 'card', prop: 'translateY', from: 0, to: -120, durationMs: 300, easing: 'cubic-out', maxOvershootPct: 0 },
        { target: 'badge', prop: 'scaleX', to: 1.25 },
      ],
    });
    expect(formatAssertions(result)).toContain('PASS 2/2');
    expect(result.pass).toBe(true);
  });

  it('explains mismatches in agent-readable messages', () => {
    const result = evaluate(report, {
      expectations: [
        { target: 'card', prop: 'translateY', durationMs: 500, easing: 'linear' },
        { target: 'badge', prop: 'scaleX', maxOvershootPct: 5 },
        { target: 'toast', minFinalVisibleRatio: 0.99 },
        { target: 'missing' },
      ],
    });
    expect(result.pass).toBe(false);
    expect(result.failed).toBe(4);

    const messages = result.results.flatMap((r) => r.failures.map((f) => f.message));
    expect(messages.some((m) => m.includes('durationMs') && m.includes('500'))).toBe(true);
    expect(messages.some((m) => m.includes('closest: cubic-out'))).toBe(true);
    expect(messages.some((m) => m.includes('overshot'))).toBe(true);
    expect(messages.some((m) => m.includes('toast') && m.includes('71%'))).toBe(true);
    expect(messages.some((m) => m.includes('never on screen'))).toBe(true);
  });
});

describe('toOtlpJson', () => {
  it('emits a root span, a span per target and a span per animation', () => {
    const otlp = toOtlpJson(report);
    const spans = otlp.resourceSpans[0].scopeSpans[0].spans as Array<{ name: string; parentSpanId?: string }>;
    const segments = report.targets.reduce((n, t) => n + t.segments.length, 0);
    expect(spans).toHaveLength(1 + report.targets.length + segments);
    expect(spans[0].name).toBe('motion-probe.record');
    expect(spans.filter((s) => s.name.startsWith('animate ')).every((s) => s.parentSpanId)).toBe(true);
  });
});
