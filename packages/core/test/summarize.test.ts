import { describe, expect, it } from 'vitest';
import { NAMED_EASINGS, formatReport, summarize } from '../src/index.js';
import { spring, synthesize, timing } from './synthetic.js';

const cubicOut = NAMED_EASINGS['cubic-out'].fn;
const linear = NAMED_EASINGS.linear.fn;

describe('summarize', () => {
  it('extracts from/to, duration and easing of a timing animation', () => {
    const trace = synthesize({
      durationMs: 800,
      targets: [
        {
          id: 'card',
          at: (t) => ({
            translateY: timing(t, 100, 300, 0, -120, cubicOut),
            opacity: timing(t, 100, 200, 0.3, 1, linear),
          }),
        },
      ],
    });

    const report = summarize(trace);
    const card = report.targets[0];
    expect(card.found).toBe(true);

    const ty = card.segments.find((s) => s.prop === 'translateY')!;
    expect(ty.kind).toBe('animation');
    expect(ty.from).toBe(0);
    expect(ty.to).toBe(-120);
    expect(ty.startMs).toBeCloseTo(100, -1);
    expect(ty.durationMs).toBeGreaterThan(270);
    expect(ty.durationMs).toBeLessThan(320);
    expect(ty.monotonic).toBe(true);
    expect(ty.overshootPct).toBe(0);
    expect(ty.easing?.name).toBe('cubic-out');
    expect(ty.easing!.bezierRmse).toBeLessThan(0.02);

    const opacity = card.segments.find((s) => s.prop === 'opacity')!;
    expect(opacity.easing?.name).toBe('linear');
    expect(opacity.durationMs).toBeCloseTo(200, -1);

    // Own transforms must not be double-reported as layout movement.
    expect(card.segments.some((s) => s.prop === 'top' || s.prop === 'left')).toBe(false);
    expect(report.frames.droppedFrames).toBe(0);
  });

  it('recognizes springs: overshoot, crossings and damping ratio', () => {
    const trace = synthesize({
      durationMs: 2500,
      targets: [{ id: 'badge', at: (t) => ({ scaleX: spring(t, 50, 1, 1.25, 0.3, 20), scaleY: 1 }) }],
    });
    const seg = summarize(trace).targets[0].segments.find((s) => s.prop === 'scaleX')!;
    expect(seg.overshootPct).toBeGreaterThan(30);
    expect(seg.oscillations).toBeGreaterThanOrEqual(2);
    expect(seg.easing).toBeUndefined();
    expect(seg.spring?.dampingRatio).toBeGreaterThan(0.25);
    expect(seg.spring?.dampingRatio).toBeLessThan(0.35);
    expect(seg.settleMs).toBeGreaterThan(seg.spring!.periodMs!);
    // Turning points (velocity ≈ 0) must not be mistaken for freezes.
    expect(seg.stalls).toEqual([]);
  });

  it('detects a visual stall (value frozen mid-animation) even when the display did not drop frames', () => {
    const trace = synthesize({
      durationMs: 1000,
      targets: [
        {
          id: 'box',
          at: (t) => {
            // JS thread blocked between 150ms and 350ms: last value is held on screen.
            const effective = t >= 150 && t < 350 ? 150 : t < 350 ? t : t - 200;
            return { translateX: timing(effective, 0, 400, 0, 200, linear) };
          },
        },
      ],
    });
    const report = summarize(trace);
    const seg = report.targets[0].segments.find((s) => s.prop === 'translateX')!;
    expect(seg.stalls).toHaveLength(1);
    expect(seg.stalls[0].durationMs).toBeGreaterThan(180);
    expect(seg.droppedFrames).toBe(0);
    expect(report.frames.droppedFrames).toBe(0);
  });

  it('counts dropped display frames', () => {
    const trace = synthesize({
      durationMs: 600,
      skip: (t) => t > 200 && t < 300,
      targets: [{ id: 'box', at: (t) => ({ translateX: timing(t, 0, 500, 0, 100, linear) }) }],
    });
    const report = summarize(trace);
    expect(report.frames.droppedFrames).toBeGreaterThanOrEqual(5);
    expect(report.frames.jank).toHaveLength(1);
    expect(report.targets[0].segments[0].droppedFrames).toBe(report.frames.droppedFrames);
  });

  it('reports clipping that value-level tracing cannot see', () => {
    const trace = synthesize({
      durationMs: 800,
      targets: [
        {
          id: 'toast',
          at: (t) => {
            const ty = timing(t, 0, 300, 80, 20, cubicOut);
            // Container is 76pt tall; toast is 56pt tall: visible part = (76 - ty) / 56.
            return { translateY: ty, height: 56, visibleRatio: Math.max(0, Math.min(1, (76 - ty) / 56)) };
          },
        },
      ],
    });
    const toast = summarize(trace).targets[0];
    expect(toast.visibility!.finalRatio).toBe(1);
    expect(toast.visibility!.minRatio).toBe(0);
    expect(toast.visibility!.clipped.length).toBe(1);
  });

  it('marks single-frame changes as jumps and tracks presence', () => {
    const trace = synthesize({
      durationMs: 500,
      targets: [
        { id: 'panel', at: (t) => (t < 100 ? null : { translateX: t < 250 ? 0 : 50 }) },
        { id: 'ghost', at: () => null },
      ],
    });
    const report = summarize(trace);
    const [panel, ghost] = report.targets;
    expect(panel.presence[0].startMs).toBeCloseTo(100, -1);
    expect(panel.segments).toHaveLength(1);
    expect(panel.segments[0].kind).toBe('jump');
    expect(ghost.found).toBe(false);

    const text = formatReport(report);
    expect(text).toContain('JUMP');
    expect(text).toContain('✗ ghost');
  });

  it('reports layout-driven movement as left/top (parent moved, not own transform)', () => {
    const trace = synthesize({
      durationMs: 600,
      targets: [{ id: 'child', at: (t) => ({ y: timing(t, 0, 300, 0, 200, cubicOut) }) }],
    });
    const segs = summarize(trace).targets[0].segments;
    expect(segs.map((s) => s.prop)).toEqual(['top']);
  });
});
