import type { AssertionReport } from './assert.js';
import type { MotionReport, Segment, TargetReport } from './schema.js';

const pct = (r: number) => `${Math.round(r * 100)}%`;

function formatCurve(s: Segment): string {
  if (s.kind === 'jump') return 'JUMP (changed within 1 frame)';
  if (s.spring) {
    const parts = [`spring overshoot ${s.overshootPct}%`, `crossings ${s.oscillations}`];
    if (s.spring.dampingRatio !== undefined) parts.push(`ζ≈${s.spring.dampingRatio}`);
    if (s.spring.periodMs !== undefined) parts.push(`period ${s.spring.periodMs}ms`);
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

function formatTarget(t: TargetReport, durationMs: number): string[] {
  if (!t.found) {
    return [`✗ ${t.id}  not found on screen (testID missing? on Android the view may be flattened → collapsable={false})`];
  }
  const presence = t.presence
    .filter((p) => p.startMs > 0 || p.endMs < durationMs)
    .map((p) => `on screen ${p.startMs}–${p.endMs}ms`)
    .join(', ');
  const v = t.visibility!;
  const hasWarning =
    v.clipped.length > 0 ||
    v.occluded.length > 0 ||
    t.segments.some((s) => s.stalls.length || s.droppedFrames || s.kind === 'jump');
  const lines = [`■ ${t.id}${hasWarning ? ' ⚠' : ''}${presence ? `  (${presence})` : ''}`];
  if (!t.segments.length) lines.push('  (no motion)');
  for (const s of t.segments) lines.push(`  ${formatSegment(s)}`);

  const visibility = [`visible      min ${pct(v.minRatio)} · final ${pct(v.finalRatio)}`];
  if (v.finalEffectiveOpacity < 0.99) visibility.push(`effective opacity ${v.finalEffectiveOpacity}`);
  if (v.clipped.length) {
    visibility.push(`⚠ clipped ${v.clipped.map((c) => `${c.startMs}–${c.endMs}ms (min ${pct(c.minRatio)})`).join(', ')}`);
  }
  if (v.occluded.length) {
    visibility.push(`⚠ covered ${v.occluded.map((o) => `${o.startMs}–${o.endMs}ms (max ${pct(o.maxRatio)})`).join(', ')}`);
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
  const lines = [header, ...report.targets.flatMap((t) => formatTarget(t, report.durationMs))];
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
