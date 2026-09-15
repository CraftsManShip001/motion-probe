import type { AssertionReport } from './assert.js';
import type { MotionReport, Segment, TargetReport } from './schema.js';

const pct = (r: number) => `${Math.round(r * 100)}%`;
const span = (i: { startMs: number; endMs: number }) =>
  i.startMs === i.endMs ? `@${i.startMs}ms (1 frame)` : `${i.startMs}–${i.endMs}ms`;

function formatCurve(s: Segment): string {
  if (s.gesture) return 'follows touch (drag)';
  if (s.kind === 'jump') return 'JUMP (changed within 1 frame)';
  if (s.loop) return `loop ${s.loop.min} ↔ ${s.loop.max} · period ${s.loop.periodMs}ms · ${s.loop.cycles} cycles`;
  if (s.spring) {
    const parts = [`spring overshoot ${s.overshootPct}%`, `crossings ${s.oscillations}`];
    if (s.spring.dampingRatio !== undefined) parts.push(`ζ≈${s.spring.dampingRatio}`);
    if (s.spring.periodMs !== undefined) parts.push(`period ${s.spring.periodMs}ms`);
    if (s.spring.stiffness !== undefined) parts.push(`≈ stiffness ${s.spring.stiffness} damping ${s.spring.damping} @ mass 1`);
    parts.push(`settle ${s.settleMs}ms`);
    return parts.join(' · ');
  }
  if (s.easing) {
    return `${s.easing.name} (rmse ${s.easing.rmse}) ≈ cubic-bezier(${s.easing.bezier.join(',')})`;
  }
  return s.from === s.to ? `returns to start · reversals ${s.oscillations}` : '';
}

function formatSegment(s: Segment): string {
  const head = `${s.prop.padEnd(12)} ${`${s.from} → ${s.to}`.padEnd(18)} @${s.startMs}ms  ${s.durationMs}ms`;
  const warnings: string[] = [];
  for (const stall of s.stalls) warnings.push(`⚠ froze ${stall.durationMs}ms @${stall.startMs}ms`);
  if (s.droppedFrames) warnings.push(`⚠ dropped ${s.droppedFrames} frames`);
  return [head, formatCurve(s), ...warnings].filter(Boolean).join('  ');
}

function formatTarget(t: TargetReport, report: MotionReport): string[] {
  if (!t.found) {
    return [`✗ ${t.id}  not found on screen (testID missing? on Android the view may be flattened → collapsable={false})`];
  }
  // Views are resolved on the first frames after arming; only mention presence when a view really
  // mounted or unmounted during the recording.
  const slack = 2 * report.frames.nominalIntervalMs;
  const presence = t.presence
    .filter((p) => p.startMs > slack || p.endMs < report.durationMs - slack)
    .map((p) => `on screen ${p.startMs}–${p.endMs}ms`)
    .join(', ');
  // ⚠ only where something needs attention; clipping while sliding in or a backdrop under a sheet is
  // listed but not flagged.
  const codes = new Set(report.issues.filter((i) => i.target === t.id && i.severity !== 'info').map((i) => i.code));
  const lines = [`■ ${t.id}${codes.size ? ' ⚠' : ''}${presence ? `  (${presence})` : ''}`];
  if (!t.segments.length) lines.push('  (no motion)');
  for (const s of t.segments) lines.push(`  ${formatSegment(s)}`);

  const v = t.visibility!;
  const transparent = v.finalEffectiveOpacity <= 0.01;
  const visibility = [`visible      min ${pct(v.minRatio)} · final ${transparent ? 'transparent' : pct(v.finalRatio)}`];
  if (!transparent && v.finalEffectiveOpacity < 0.99) visibility.push(`effective opacity ${v.finalEffectiveOpacity}`);
  if (v.clipped.length) {
    const mark = codes.has('clipped-at-end') ? '⚠ ' : '';
    visibility.push(`${mark}clipped ${v.clipped.map((c) => `${span(c)} (min ${pct(c.minRatio)})`).join(', ')}`);
  }
  if (v.occluded.length) {
    const mark = codes.has('occluded-at-end') ? '⚠ ' : '';
    visibility.push(`${mark}covered ${v.occluded.map((o) => `${span(o)} (max ${pct(o.maxRatio)})`).join(', ')}`);
  }
  lines.push(`  ${visibility.join(' · ')}`);
  return lines;
}

/** Compact, token-cheap text for agents and terminals. */
export function formatReport(report: MotionReport): string {
  const f = report.frames;
  const header = [
    `motion-probe · ${report.platform}${report.app?.deviceName ? ` (${report.app.deviceName})` : ''}`,
    `${report.durationMs}ms (${report.endReason})`,
    `${f.fps}fps`,
    `dropped ${f.droppedFrames}${f.droppedFrames ? ` (worst gap ${f.worstGapMs}ms)` : ''}`,
  ].join(' · ');
  const lines = [header, ...report.targets.flatMap((t) => formatTarget(t, report))];
  const notable = report.issues.filter((i) => i.severity !== 'info');
  if (notable.length) {
    const label = (i: (typeof notable)[number]) => `${i.code}${i.target ? `(${i.target}${i.prop ? `.${i.prop}` : ''})` : ''}`;
    lines.push(`issues: ${notable.map(label).join(', ')}`);
  }
  return lines.join('\n');
}

export function formatAssertions(result: AssertionReport): string {
  const lines = [`${result.pass ? 'PASS' : 'FAIL'} ${result.passed}/${result.passed + result.failed} expectations`];
  for (const r of result.results) {
    const label = `${r.target}${r.prop ? `.${r.prop}` : ''}`;
    if (r.pass) lines.push(`  ✓ ${label}`);
    else for (const f of r.failures) lines.push(`  ✗ ${label}: ${f.message}`);
  }
  return lines.join('\n');
}
