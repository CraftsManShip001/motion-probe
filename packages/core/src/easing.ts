import type { Bezier, EasingFit } from './schema.js';

export type EasingFn = (u: number) => number;

/** Normalized progress sample: `u` = time in [0, 1], `p` = progress (0 = from, 1 = to). */
export interface CurvePoint {
  u: number;
  p: number;
}

export function cubicBezier([x1, y1, x2, y2]: Bezier): EasingFn {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (s: number) => ((ax * s + bx) * s + cx) * s;
  const sampleY = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let s = u;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(s) - u;
      if (Math.abs(dx) < 1e-6) return sampleY(s);
      const slope = slopeX(s);
      if (Math.abs(slope) < 1e-6) break;
      s -= dx / slope;
    }
    let lo = 0;
    let hi = 1;
    s = u;
    for (let i = 0; i < 40; i++) {
      const x = sampleX(s);
      if (Math.abs(x - u) < 1e-6) break;
      if (x < u) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return sampleY(s);
  };
}

const quad: EasingFn = (u) => u * u;
const cubic: EasingFn = (u) => u * u * u;
const sin: EasingFn = (u) => 1 - Math.cos((u * Math.PI) / 2);
const out = (f: EasingFn): EasingFn => (u) => 1 - f(1 - u);
const inOut =
  (f: EasingFn): EasingFn =>
  (u) =>
    u < 0.5 ? f(u * 2) / 2 : 1 - f((1 - u) * 2) / 2;

/** Named curves, including the defaults of the common RN animation APIs. */
export const NAMED_EASINGS: Record<string, { fn: EasingFn; description: string }> = {
  linear: { fn: (u) => u, description: 'linear' },
  ease: { fn: cubicBezier([0.25, 0.1, 0.25, 1]), description: 'CSS ease' },
  'ease-in': { fn: cubicBezier([0.42, 0, 1, 1]), description: 'CSS ease-in / RN Easing.ease' },
  'ease-out': { fn: cubicBezier([0, 0, 0.58, 1]), description: 'CSS ease-out' },
  'ease-in-out': { fn: cubicBezier([0.42, 0, 0.58, 1]), description: 'CSS ease-in-out' },
  'quad-in': { fn: quad, description: 'Easing.in(Easing.quad)' },
  'quad-out': { fn: out(quad), description: 'Easing.out(Easing.quad)' },
  'quad-in-out': { fn: inOut(quad), description: 'Easing.inOut(Easing.quad) — Reanimated withTiming default' },
  'cubic-in': { fn: cubic, description: 'Easing.in(Easing.cubic)' },
  'cubic-out': { fn: out(cubic), description: 'Easing.out(Easing.cubic)' },
  'cubic-in-out': { fn: inOut(cubic), description: 'Easing.inOut(Easing.cubic)' },
  'sin-in-out': { fn: inOut(sin), description: 'Easing.inOut(Easing.sin)' },
  'rn-ease-in-out': {
    fn: inOut(cubicBezier([0.42, 0, 1, 1])),
    description: 'Easing.inOut(Easing.ease) — Animated.timing default',
  },
};

export function resolveEasing(easing: string | Bezier): EasingFn | undefined {
  if (typeof easing === 'string') return NAMED_EASINGS[easing]?.fn;
  return cubicBezier(easing);
}

export function rmse(points: CurvePoint[], fn: EasingFn): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const { u, p } of points) {
    const d = fn(u) - p;
    sum += d * d;
  }
  return Math.sqrt(sum / points.length);
}

function downsample(points: CurvePoint[], max: number): CurvePoint[] {
  if (points.length <= max) return points;
  const out: CurvePoint[] = [];
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]);
  }
  return out;
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

function fitBezier(points: CurvePoint[]): { bezier: Bezier; rmse: number } {
  let best: Bezier = [0, 0, 1, 1];
  let bestErr = rmse(points, cubicBezier(best));
  const consider = (b: Bezier) => {
    const err = rmse(points, cubicBezier(b));
    if (err < bestErr) {
      bestErr = err;
      best = b;
    }
  };

  const xs = range(0, 1, 0.1);
  const ys = range(-0.3, 1.3, 0.1);
  for (const x1 of xs) for (const x2 of xs) for (const y1 of ys) for (const y2 of ys) consider([x1, y1, x2, y2]);

  for (const step of [0.025, 0.01]) {
    const [bx1, by1, bx2, by2] = best;
    const around = (c: number, lo: number, hi: number) =>
      range(-4 * step, 4 * step, step)
        .map((d) => Math.round((c + d) * 1000) / 1000)
        .filter((v) => v >= lo && v <= hi);
    for (const x1 of around(bx1, 0, 1))
      for (const x2 of around(bx2, 0, 1))
        for (const y1 of around(by1, -1, 2))
          for (const y2 of around(by2, -1, 2)) consider([x1, y1, x2, y2]);
  }
  return { bezier: best, rmse: bestErr };
}

export function fitEasing(points: CurvePoint[]): EasingFit {
  const sample = downsample(points, 48);
  let name = 'linear';
  let nameErr = Infinity;
  for (const [candidate, { fn }] of Object.entries(NAMED_EASINGS)) {
    const err = rmse(sample, fn);
    if (err < nameErr) {
      nameErr = err;
      name = candidate;
    }
  }
  const { bezier, rmse: bezierRmse } = fitBezier(sample);
  return { name, rmse: nameErr, bezier, bezierRmse };
}
