import { SPEC_SCHEMA, type Expectation, type MotionSpec } from './assert.js';
import { NAMED_EASINGS } from './easing.js';
import { MOTION_PROPS, type Bezier, type MotionProp } from './schema.js';

/**
 * Design motion tokens → motion-probe spec.
 *
 * Accepts W3C Design Tokens (DTCG) files — `$value` / `$type` with group type inheritance, aliases
 * like `{motion.duration.normal}`, `duration` (`"250ms"`, `"0.25s"` or `{ value, unit }`),
 * `cubicBezier` and composite `transition` tokens — as well as plain nested JSON. Springs use a
 * `spring` token: `{ dampingRatio }`, Reanimated-style `{ damping, stiffness, mass }`, or explicit
 * `{ maxOvershootPct, settleMs }`.
 */

export type ResolvedToken =
  | { type: 'duration'; ms: number }
  | { type: 'number'; value: number }
  | { type: 'easing'; easing: string | Bezier }
  | { type: 'transition'; durationMs?: number; delayMs?: number; easing?: string | Bezier }
  | { type: 'spring'; dampingRatio?: number; maxOvershootPct?: number; settleMs?: number };

export class MotionTokenError extends Error {}

export interface MotionDefinition {
  target: string;
  prop: MotionProp;
  from?: number;
  to?: number;
  tolerance?: number;
  /** Token reference (`motion.duration.normal` or `{motion.duration.normal}`) or literal (`"250ms"`, `250`). */
  duration?: string | number;
  /** Token reference, easing name, `cubic-bezier(...)` or control points. */
  easing?: string | Bezier;
  /** Composite transition token reference (duration + easing). */
  transition?: string;
  /** Spring token reference or inline spring config. */
  spring?: string | Record<string, unknown>;
  /** Add `minFinalVisibleRatio: 0.99` for the target. */
  fullyVisibleAtEnd?: boolean;
  /** Defaults to true: no mid-animation freezes allowed. */
  smooth?: boolean;
  maxDroppedFrames?: number;
}

export interface MotionDocument {
  tokens?: unknown;
  motions: MotionDefinition[];
}

export interface TokenSpecOptions {
  /** Extra token documents (merged in order, later wins) besides `document.tokens`. */
  tokens?: unknown[];
  /** Relative duration tolerance. Default 10%. */
  timingTolerancePct?: number;
  /** Absolute duration tolerance floor. Default 34ms (two frames at 60fps). */
  minTimingToleranceMs?: number;
  maxEasingRmse?: number;
  description?: string;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isBezier = (v: unknown): v is Bezier => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number');
const SPRING_KEYS = ['dampingRatio', 'damping', 'stiffness', 'mass', 'maxOvershootPct', 'settleMs'];
const TRANSITION_KEYS = ['duration', 'delay', 'timingFunction', 'easing'];

/** Levenshtein distance, for "did you mean" suggestions on mistyped token paths. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

function deepMerge(target: Json, source: unknown) {
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (isObject(value) && isObject(target[key]) && !('$value' in value)) deepMerge(target[key] as Json, value);
    else target[key] = value;
  }
}

export class MotionTokens {
  private readonly root: Json = {};

  constructor(...documents: unknown[]) {
    for (const document of documents) deepMerge(this.root, document);
  }

  /** Resolves a token reference or literal. */
  resolve(value: unknown, context = String(value)): ResolvedToken {
    return this.resolveValue(value, undefined, [], context);
  }

  private lookup(path: string): { node: unknown; type?: string } | undefined {
    let node: unknown = this.root;
    let type: string | undefined;
    for (const key of path.split('.')) {
      if (!isObject(node)) return undefined;
      if (typeof node.$type === 'string') type = node.$type;
      if (!(key in node)) return undefined;
      node = node[key];
    }
    if (isObject(node) && typeof node.$type === 'string') type = node.$type;
    return { node, type };
  }

  private paths(node: unknown = this.root, prefix = ''): string[] {
    if (!isObject(node) || '$value' in node) return prefix ? [prefix] : [];
    const keys = Object.keys(node).filter((k) => !k.startsWith('$'));
    const composite = keys.length > 0 && keys.every((k) => TRANSITION_KEYS.includes(k) || SPRING_KEYS.includes(k));
    if (composite && prefix) return [prefix];
    return keys.flatMap((k) => this.paths(node[k], prefix ? `${prefix}.${k}` : k));
  }

  private unknownToken(path: string, context: string): MotionTokenError {
    const known = this.paths();
    const similar = known
      .map((candidate) => ({ candidate, distance: editDistance(candidate, path) }))
      .filter(({ distance }) => distance <= Math.max(2, Math.floor(path.length / 5)))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
      .map(({ candidate }) => candidate);
    const hint = similar.length ? ` Did you mean: ${similar.join(', ')}?` : ` Known tokens: ${known.slice(0, 12).join(', ')}`;
    return new MotionTokenError(`unknown token "${path}" (in ${context}).${hint}`);
  }

  private resolveValue(value: unknown, type: string | undefined, trail: string[], context: string): ResolvedToken {
    if (typeof value === 'string') {
      const alias = value.match(/^\{([^}]+)\}$/)?.[1];
      const path = alias ?? (/^[A-Za-z_][\w-]*(\.[\w-]+)+$/.test(value) ? value : undefined);
      if (path) {
        const found = this.lookup(path);
        if (found) {
          if (trail.includes(path)) throw new MotionTokenError(`circular token reference: ${[...trail, path].join(' → ')}`);
          const node = found.node;
          const nodeType = found.type ?? type;
          return isObject(node) && '$value' in node
            ? this.resolveValue(node.$value, nodeType, [...trail, path], context)
            : this.resolveValue(node, nodeType, [...trail, path], context);
        }
        if (alias || !NAMED_EASINGS[value]) throw this.unknownToken(path, context);
      }
      return this.literalString(value, type, context);
    }

    if (typeof value === 'number') return type === 'duration' ? { type: 'duration', ms: value } : { type: 'number', value };
    if (isBezier(value)) return { type: 'easing', easing: value };

    if (isObject(value)) {
      if (typeof value.value === 'number' && (value.unit === 'ms' || value.unit === 's')) {
        return { type: 'duration', ms: value.unit === 's' ? value.value * 1000 : value.value };
      }
      if (type === 'spring' || Object.keys(value).some((k) => SPRING_KEYS.includes(k))) {
        return this.spring(value, trail, context);
      }
      if (type === 'transition' || Object.keys(value).some((k) => TRANSITION_KEYS.includes(k))) {
        const duration = value.duration !== undefined ? this.duration(this.resolveValue(value.duration, 'duration', trail, context), context) : undefined;
        const delay = value.delay !== undefined ? this.duration(this.resolveValue(value.delay, 'duration', trail, context), context) : undefined;
        const easingValue = value.timingFunction ?? value.easing;
        const easing = easingValue !== undefined ? this.easing(this.resolveValue(easingValue, 'cubicBezier', trail, context), context) : undefined;
        return { type: 'transition', durationMs: duration, delayMs: delay, easing };
      }
    }
    throw new MotionTokenError(`cannot interpret ${JSON.stringify(value)} (in ${context})`);
  }

  private literalString(value: string, type: string | undefined, context: string): ResolvedToken {
    const duration = value.match(/^(-?\d*\.?\d+)\s*(ms|s)$/);
    if (duration) return { type: 'duration', ms: Number(duration[1]) * (duration[2] === 's' ? 1000 : 1) };
    const bezier = value.match(/^cubic-bezier\(\s*([^)]+)\)$/);
    if (bezier) {
      const points = bezier[1].split(',').map((n) => Number(n.trim()));
      if (isBezier(points) && points.every(Number.isFinite)) return { type: 'easing', easing: points };
    }
    if (NAMED_EASINGS[value]) return { type: 'easing', easing: value };
    if (type === 'number' || type === 'duration') {
      const n = Number(value);
      if (Number.isFinite(n)) return type === 'duration' ? { type: 'duration', ms: n } : { type: 'number', value: n };
    }
    throw new MotionTokenError(
      `cannot interpret "${value}" (in ${context}): expected a token reference, a duration like "250ms", ` +
        `cubic-bezier(...), or one of ${Object.keys(NAMED_EASINGS).join(', ')}`,
    );
  }

  private number(value: unknown, trail: string[], context: string): number | undefined {
    if (value === undefined) return undefined;
    const resolved = this.resolveValue(value, 'number', trail, context);
    if (resolved.type === 'number') return resolved.value;
    if (resolved.type === 'duration') return resolved.ms;
    throw new MotionTokenError(`expected a number in ${context}, got a ${resolved.type} token`);
  }

  private spring(config: Json, trail: string[], context: string): ResolvedToken {
    const stiffness = this.number(config.stiffness, trail, context);
    const damping = this.number(config.damping, trail, context);
    const mass = this.number(config.mass, trail, context) ?? 1;
    let dampingRatio = this.number(config.dampingRatio, trail, context);
    if (dampingRatio === undefined && stiffness !== undefined && damping !== undefined) {
      dampingRatio = damping / (2 * Math.sqrt(stiffness * mass));
    }

    let maxOvershootPct = this.number(config.maxOvershootPct, trail, context);
    if (maxOvershootPct === undefined && dampingRatio !== undefined) {
      maxOvershootPct = dampingRatio >= 1 ? 0 : 100 * Math.exp((-dampingRatio * Math.PI) / Math.sqrt(1 - dampingRatio * dampingRatio));
    }
    let settleMs = this.number(config.settleMs, trail, context);
    if (settleMs === undefined && dampingRatio !== undefined && dampingRatio > 0 && stiffness !== undefined) {
      // 2% envelope of an underdamped oscillator: t ≈ 4 / (ζ·ω₀)
      settleMs = (4 / (Math.min(dampingRatio, 1) * Math.sqrt(stiffness / mass))) * 1000;
    }
    const round1 = (v: number | undefined) => (v === undefined ? undefined : Math.round(v * 10) / 10);
    return {
      type: 'spring',
      dampingRatio: dampingRatio === undefined ? undefined : Math.round(dampingRatio * 1000) / 1000,
      maxOvershootPct: round1(maxOvershootPct),
      settleMs: round1(settleMs),
    };
  }

  duration(token: ResolvedToken, context: string): number {
    if (token.type === 'duration') return token.ms;
    if (token.type === 'number') return token.value;
    if (token.type === 'transition' && token.durationMs !== undefined) return token.durationMs;
    throw new MotionTokenError(`${context} is a ${token.type} token, expected a duration`);
  }

  easing(token: ResolvedToken, context: string): string | Bezier {
    if (token.type === 'easing') return token.easing;
    if (token.type === 'transition' && token.easing !== undefined) return token.easing;
    throw new MotionTokenError(`${context} is a ${token.type} token, expected an easing`);
  }
}

/** Builds a spec that checks the running app against the motion defined by design tokens. */
export function specFromMotionTokens(document: MotionDocument, options: TokenSpecOptions = {}): MotionSpec {
  if (!document || !Array.isArray(document.motions)) {
    throw new MotionTokenError('motion document needs a "motions" array');
  }
  const tokens = new MotionTokens(document.tokens, ...(options.tokens ?? []));
  const relative = (options.timingTolerancePct ?? 10) / 100;
  const floor = options.minTimingToleranceMs ?? 34;
  const tolerance = (ms: number) => Math.round(Math.max(floor, ms * relative));

  const expectations: Expectation[] = [];
  const fullyVisible = new Set<string>();

  document.motions.forEach((motion, i) => {
    const where = `motions[${i}] (${motion.target}.${motion.prop})`;
    if (!motion.target) throw new MotionTokenError(`${where}: "target" is required`);
    if (!MOTION_PROPS.includes(motion.prop)) {
      throw new MotionTokenError(`${where}: unknown prop "${motion.prop}" (${MOTION_PROPS.join(', ')})`);
    }

    const expectation: Expectation = { target: motion.target, prop: motion.prop };
    if (motion.from !== undefined) expectation.from = motion.from;
    if (motion.to !== undefined) expectation.to = motion.to;
    if (motion.tolerance !== undefined) expectation.tolerance = motion.tolerance;

    let durationMs: number | undefined;
    let easing: string | Bezier | undefined;
    if (motion.transition !== undefined) {
      const transition = tokens.resolve(motion.transition, `${where}.transition`);
      durationMs = tokens.duration(transition, `${where}.transition`);
      if (transition.type === 'transition') easing = transition.easing;
    }
    if (motion.duration !== undefined) {
      durationMs = tokens.duration(tokens.resolve(motion.duration, `${where}.duration`), `${where}.duration`);
    }
    if (motion.easing !== undefined) {
      easing = tokens.easing(tokens.resolve(motion.easing, `${where}.easing`), `${where}.easing`);
    }

    if (motion.spring !== undefined) {
      const spring = tokens.resolve(motion.spring, `${where}.spring`);
      if (spring.type !== 'spring') throw new MotionTokenError(`${where}.spring is a ${spring.type} token, expected a spring`);
      if (spring.maxOvershootPct !== undefined) {
        expectation.maxOvershootPct = Math.ceil(spring.maxOvershootPct * 1.25 + 3);
        if (spring.maxOvershootPct >= 5) expectation.minOvershootPct = Math.floor(spring.maxOvershootPct * 0.5);
      }
      if (spring.settleMs !== undefined) expectation.settleMs = { max: Math.round(spring.settleMs * 1.3) };
    } else {
      if (durationMs !== undefined) expectation.durationMs = { value: durationMs, tolerance: tolerance(durationMs) };
      if (easing !== undefined) {
        expectation.easing = easing;
        expectation.maxEasingRmse = options.maxEasingRmse ?? 0.05;
        expectation.maxOvershootPct = 2;
      }
    }
    if (motion.smooth !== false) expectation.maxStalls = 0;
    if (motion.maxDroppedFrames !== undefined) expectation.maxDroppedFrames = motion.maxDroppedFrames;
    expectations.push(expectation);

    if (motion.fullyVisibleAtEnd && !fullyVisible.has(motion.target)) {
      fullyVisible.add(motion.target);
      expectations.push({ target: motion.target, minFinalVisibleRatio: 0.99 });
    }
  });

  return {
    schema: SPEC_SCHEMA,
    meta: { source: 'motion-tokens', generatedAt: new Date().toISOString(), description: options.description },
    expectations,
  };
}
