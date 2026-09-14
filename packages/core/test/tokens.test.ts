import { describe, expect, it } from 'vitest';
import { MotionTokenError, MotionTokens, NAMED_EASINGS, evaluate, specFromMotionTokens, summarize } from '../src/index.js';
import { spring, synthesize, timing } from './synthetic.js';

/** W3C Design Tokens (DTCG) style: group $type, aliases, object durations, composite transition. */
const dtcg = {
  motion: {
    duration: {
      $type: 'duration',
      short: { $value: '200ms' },
      long: { $value: { value: 300, unit: 'ms' } },
      slow: { $value: '0.4s' },
    },
    easing: {
      $type: 'cubicBezier',
      decelerate: { $value: [0.215, 0.61, 0.355, 1] },
      standard: { $value: '{motion.easing.decelerate}' },
    },
    transition: {
      enter: {
        $type: 'transition',
        $value: { duration: '{motion.duration.long}', delay: '0ms', timingFunction: '{motion.easing.standard}' },
      },
    },
    spring: {
      playful: { $type: 'spring', $value: { damping: 6, stiffness: 120, mass: 1 } },
    },
  },
};

describe('MotionTokens', () => {
  const tokens = new MotionTokens(dtcg);

  it('resolves DTCG durations in every notation', () => {
    expect(tokens.resolve('motion.duration.short')).toEqual({ type: 'duration', ms: 200 });
    expect(tokens.resolve('{motion.duration.long}')).toEqual({ type: 'duration', ms: 300 });
    expect(tokens.resolve('motion.duration.slow')).toEqual({ type: 'duration', ms: 400 });
  });

  it('follows alias chains and composite transitions', () => {
    expect(tokens.resolve('motion.easing.standard')).toEqual({ type: 'easing', easing: [0.215, 0.61, 0.355, 1] });
    expect(tokens.resolve('motion.transition.enter')).toEqual({
      type: 'transition',
      durationMs: 300,
      delayMs: 0,
      easing: [0.215, 0.61, 0.355, 1],
    });
  });

  it('derives overshoot and settle time from a Reanimated-style spring config', () => {
    const playful = tokens.resolve('motion.spring.playful');
    expect(playful.type).toBe('spring');
    if (playful.type !== 'spring') return;
    expect(playful.dampingRatio).toBeCloseTo(0.274, 3);
    expect(playful.maxOvershootPct).toBeGreaterThan(38);
    expect(playful.maxOvershootPct).toBeLessThan(43);
    expect(playful.settleMs).toBeGreaterThan(1250);
    expect(playful.settleMs).toBeLessThan(1400);
  });

  it('accepts literals and plain (non-DTCG) token files', () => {
    const plain = new MotionTokens({ motion: { duration: { normal: 250 }, easing: { out: 'cubic-out' } } });
    expect(plain.duration(plain.resolve('motion.duration.normal'), 'test')).toBe(250);
    expect(plain.resolve('motion.easing.out')).toEqual({ type: 'easing', easing: 'cubic-out' });
    expect(plain.resolve('cubic-bezier(0.4, 0, 0.2, 1)')).toEqual({ type: 'easing', easing: [0.4, 0, 0.2, 1] });
    expect(plain.resolve('0.25s')).toEqual({ type: 'duration', ms: 250 });
  });

  it('explains unknown tokens and type mismatches', () => {
    expect(() => tokens.resolve('{motion.duration.lnog}')).toThrow(/unknown token "motion.duration.lnog"/);
    expect(() => tokens.resolve('motion.duration.shrt', 'motions[0].duration')).toThrow(MotionTokenError);
    expect(() => tokens.resolve('motion.duration.shrot')).toThrow(/Did you mean: motion\.duration\.short/);
    expect(() => tokens.duration(tokens.resolve('motion.easing.decelerate'), 'motions[0].duration')).toThrow(
      /is a easing token, expected a duration/,
    );
  });
});

describe('specFromMotionTokens', () => {
  const document = {
    tokens: dtcg,
    motions: [
      { target: 'card', prop: 'translateY' as const, from: 0, to: -120, transition: 'motion.transition.enter' },
      { target: 'toast', prop: 'translateY' as const, to: 8, duration: '{motion.duration.short}', easing: 'ease-out', fullyVisibleAtEnd: true },
      { target: 'badge', prop: 'scaleX' as const, from: 1, to: 1.3, spring: 'motion.spring.playful' },
    ],
  };
  const spec = specFromMotionTokens(document);

  it('turns token references into expectations with tolerances', () => {
    expect(spec.expectations).toHaveLength(4);
    const [card, toast, toastVisible, badge] = spec.expectations;
    expect(card).toMatchObject({
      target: 'card',
      durationMs: { value: 300, tolerance: 34 },
      easing: [0.215, 0.61, 0.355, 1],
      maxOvershootPct: 2,
      maxStalls: 0,
    });
    expect(toast).toMatchObject({ durationMs: { value: 200, tolerance: 34 }, easing: 'ease-out' });
    expect(toastVisible).toEqual({ target: 'toast', minFinalVisibleRatio: 0.99 });
    expect(badge.durationMs).toBeUndefined();
    expect(badge.minOvershootPct).toBeGreaterThanOrEqual(19);
    expect(badge.maxOvershootPct).toBeGreaterThanOrEqual(50);
    expect(badge.settleMs).toMatchObject({ max: expect.any(Number) });
  });

  it('passes a recording that follows the design tokens and fails one that does not', () => {
    const cubicOut = NAMED_EASINGS['cubic-out'].fn;
    const record = (cardDuration: number, zeta: number) =>
      summarize(
        synthesize({
          durationMs: 2500,
          targets: [
            { id: 'card', at: (t) => ({ translateY: timing(t, 0, cardDuration, 0, -120, cubicOut) }) },
            { id: 'badge', at: (t) => ({ scaleX: spring(t, 0, 1, 1.3, zeta, Math.sqrt(120)) }) },
          ],
        }),
      );
    const tokenSpec = { expectations: spec.expectations.filter((e) => e.target !== 'toast') };

    const good = evaluate(record(300, 0.274), tokenSpec);
    expect(good.results.filter((r) => !r.pass)).toEqual([]);

    const bad = evaluate(record(500, 0.9), tokenSpec);
    const failed = bad.results.filter((r) => !r.pass).map((r) => r.target);
    expect(failed).toEqual(['card', 'badge']);
  });

  it('rejects unknown props with the list of valid ones', () => {
    expect(() => specFromMotionTokens({ motions: [{ target: 'x', prop: 'height' as never, duration: 100 }] })).toThrow(
      /unknown prop "height"/,
    );
  });
});
