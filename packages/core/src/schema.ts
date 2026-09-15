export const RAW_TRACE_SCHEMA = 'motion-probe/raw-trace@1' as const;
export const REPORT_SCHEMA = 'motion-probe/report@1' as const;

/**
 * Column order of a native sample row. Natives send `columns` too, so readers index by name and
 * traces from older probes (without the trailing columns) still analyze.
 */
export const SAMPLE_COLUMNS = [
  'frame',
  'target',
  'present',
  'x',
  'y',
  'width',
  'height',
  'boundsWidth',
  'boundsHeight',
  'translateX',
  'translateY',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
  'effectiveOpacity',
  /** Share of the view's area inside every clipping ancestor and the screen. */
  'visibleRatio',
  /** Share of that visible area covered by views painted above the target. */
  'occludedRatio',
  /** Sum of ancestor scroll offsets (content offset of enclosing scroll views). */
  'scrollX',
  'scrollY',
  /**
   * Opacity of what the view draws inside itself (descendant images, text and backgrounds, and
   * cross-dissolve transitions), relative to the view; 0 while it draws nothing.
   */
  'contentOpacity',
] as const;
export type SampleColumn = (typeof SAMPLE_COLUMNS)[number];

export type Platform = 'ios' | 'android';
export type EndReason = 'settled' | 'timeout' | 'maxDuration' | 'cancelled';

export interface AppInfo {
  name?: string;
  platform: Platform;
  osVersion?: string;
  deviceName?: string;
}

/**
 * What the native probe recorded. `frameTimes[i]` is the display time of frame `i` in ms since arm.
 * `samples` only contain rows whose values changed, so series are step-held between rows.
 */
export interface RawTrace {
  schema: typeof RAW_TRACE_SCHEMA;
  platform: Platform;
  app?: AppInfo;
  startedAt: number;
  targets: string[];
  columns: string[];
  frameTimes: number[];
  samples: number[][];
  endReason: EndReason;
  /** When a finger was on the screen (probes from 0.1.4). */
  touches?: TouchInterval[];
}

/** A touch sequence: from the first finger down to the last finger up. */
export interface TouchInterval {
  startMs: number;
  /** Last finger up; the end of the recording when still touching. */
  endMs: number;
  /** Farthest any finger moved from where it went down (points / dp): a press barely moves, a drag does. */
  distance: number;
}

/**
 * Properties the analyzer segments into animations.
 * - `left`/`top`: layout position, compensated for the view's own transform and for scrolling, so
 *   they only move when a parent or layout moved the view.
 * - `scrollX`/`scrollY`: scrolling of the enclosing scroll views.
 * - `inheritedOpacity`: combined opacity of the ancestors (a screen or card fading in), without the
 *   view's own `opacity`.
 * - `contentOpacity`: opacity of what the view draws inside itself (an image fading in).
 */
export const MOTION_PROPS = [
  'translateX',
  'translateY',
  'scaleX',
  'scaleY',
  'rotation',
  'opacity',
  'inheritedOpacity',
  'contentOpacity',
  'boundsWidth',
  'boundsHeight',
  'left',
  'top',
  'scrollX',
  'scrollY',
] as const;
export type MotionProp = (typeof MOTION_PROPS)[number];

/** Smallest change that counts as motion, per prop (points, ratio or degrees). */
export const DEFAULT_EPSILON: Record<MotionProp, number> = {
  translateX: 0.5,
  translateY: 0.5,
  scaleX: 0.005,
  scaleY: 0.005,
  rotation: 0.5,
  opacity: 0.01,
  inheritedOpacity: 0.01,
  contentOpacity: 0.01,
  boundsWidth: 0.5,
  boundsHeight: 0.5,
  left: 0.5,
  top: 0.5,
  scrollX: 0.5,
  scrollY: 0.5,
};

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface Stall extends Interval {
  durationMs: number;
  /** Display frames during which the value did not change although the animation was not done. */
  frames: number;
}

export type Bezier = readonly [number, number, number, number];

export interface EasingFit {
  /** Closest named curve. */
  name: string;
  rmse: number;
  /** Best-fit cubic-bezier for the observed progress curve. */
  bezier: Bezier;
  bezierRmse: number;
}

export interface SpringFit {
  dampingRatio?: number;
  periodMs?: number;
  /** Equivalent stiffness at mass 1 (from damping ratio and period). */
  stiffness?: number;
  /** Equivalent damping at mass 1. */
  damping?: number;
}

/** A sustained oscillation (pulse, breathing, shimmer): swings that do not decay. */
export interface SegmentLoop {
  min: number;
  max: number;
  periodMs: number;
  /** Cycles observed in the recording (a loop that never stops is also reported as never-settled). */
  cycles: number;
}

export interface Segment {
  /** Present when the segment is a repeating loop rather than a single animation. */
  loop?: SegmentLoop;
  prop: MotionProp;
  /** `jump` = the value changed within a single frame. */
  kind: 'animation' | 'jump';
  /**
   * The value changed while a finger dragged (the view follows the touch): no curve is fitted. What
   * happens after the finger lifts (a release or fling animation) is a separate segment.
   */
  gesture?: boolean;
  from: number;
  to: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  /** Time until the value stayed within 2% of `to`. */
  settleMs: number;
  monotonic: boolean;
  overshootPct: number;
  /** Number of times the value crossed `to`. */
  oscillations: number;
  easing?: EasingFit;
  spring?: SpringFit;
  stalls: Stall[];
  droppedFrames: number;
}

export interface RatioInterval extends Interval {
  minRatio: number;
}
/** @deprecated use RatioInterval */
export type ClippedInterval = RatioInterval;

export interface OccludedInterval extends Interval {
  maxRatio: number;
}

export interface Visibility {
  /** Minimum effectively visible share (not clipped and not covered) during motion. */
  minRatio: number;
  /** Effectively visible share at the end. */
  finalRatio: number;
  /** Share inside clipping ancestors and the screen at the end. */
  finalClipRatio: number;
  /** Share of the unclipped area covered by views painted above, at the end. */
  finalOccludedRatio: number;
  finalEffectiveOpacity: number;
  /** Effectively visible share below 99% (either cause). */
  hidden: RatioInterval[];
  /** Cut off by an ancestor with overflow hidden, a scroll viewport, or the screen. */
  clipped: RatioInterval[];
  /** Covered by other views (overlays, siblings with a higher zIndex). */
  occluded: OccludedInterval[];
}

export type FinalState = Record<
  | 'x'
  | 'y'
  | 'width'
  | 'height'
  | 'translateX'
  | 'translateY'
  | 'scaleX'
  | 'scaleY'
  | 'rotation'
  | 'opacity'
  | 'effectiveOpacity'
  | 'visibleRatio'
  | 'occludedRatio'
  | 'scrollX'
  | 'scrollY',
  number
>;

export interface TargetReport {
  id: string;
  found: boolean;
  presence: Interval[];
  motion?: Interval;
  segments: Segment[];
  visibility?: Visibility;
  final?: FinalState;
}

export interface JankInterval extends Interval {
  droppedFrames: number;
}

export interface FrameStats {
  count: number;
  nominalIntervalMs: number;
  fps: number;
  droppedFrames: number;
  worstGapMs: number;
  jank: JankInterval[];
}

export type IssueCode =
  | 'target-not-found'
  | 'no-motion'
  | 'never-settled'
  | 'jump'
  | 'stall'
  | 'dropped-frames'
  | 'clipped-at-end'
  | 'clipped-during-motion'
  | 'offscreen-at-end'
  | 'occluded-at-end'
  | 'occluded-during-motion'
  | 'covered-at-end'
  | 'scrolled-out-of-view'
  | 'invisible-at-end'
  | 'unmounted';

/** Problems detected without a spec, so an agent gets a verdict even when nobody wrote expectations. */
export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: IssueCode;
  target?: string;
  prop?: MotionProp;
  atMs?: number;
  message: string;
}

export interface MotionReport {
  schema: typeof REPORT_SCHEMA;
  platform: Platform;
  app?: AppInfo;
  startedAt: number;
  durationMs: number;
  endReason: EndReason;
  frames: FrameStats;
  targets: TargetReport[];
  issues: Issue[];
}
