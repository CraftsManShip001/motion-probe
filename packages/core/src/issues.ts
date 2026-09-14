import type { Interval, Issue, MotionReport } from './schema.js';

const pct = (r: number) => `${Math.round(r * 100)}%`;
const overlaps = (a: Interval, b: Interval) => a.endMs >= b.startMs && a.startMs <= b.endMs;

export function detectIssues(report: Omit<MotionReport, 'issues'>): Issue[] {
  const issues: Issue[] = [];

  if (report.endReason === 'maxDuration') {
    issues.push({
      severity: 'warning',
      code: 'never-settled',
      message: `recording hit the ${report.durationMs}ms cap before motion settled (infinite or very long animation?)`,
    });
  } else if (report.endReason === 'timeout') {
    issues.push({ severity: 'info', code: 'no-motion', message: 'nothing moved before the timeout (did the trigger run?)' });
  }

  for (const t of report.targets) {
    if (!t.found) {
      issues.push({
        severity: 'error',
        code: 'target-not-found',
        target: t.id,
        message: `"${t.id}" was never on screen: check the testID (Android: the view may be flattened, add collapsable={false})`,
      });
      continue;
    }

    for (const s of t.segments) {
      const where = { target: t.id, prop: s.prop, atMs: s.startMs };
      if (s.kind === 'jump') {
        issues.push({
          severity: 'warning',
          code: 'jump',
          ...where,
          message: `${t.id}.${s.prop} jumped ${s.from} → ${s.to} within one frame at ${s.startMs}ms (missing animation?)`,
        });
      }
      if (s.stalls.length) {
        const worst = Math.max(...s.stalls.map((stall) => stall.durationMs));
        issues.push({
          severity: 'warning',
          code: 'stall',
          ...where,
          atMs: s.stalls[0].startMs,
          message: `${t.id}.${s.prop} froze ${s.stalls.length}× mid-animation (worst ${worst}ms): JS thread blocked while a JS-driven animation ran?`,
        });
      }
      if (s.droppedFrames) {
        issues.push({
          severity: 'warning',
          code: 'dropped-frames',
          ...where,
          message: `${s.droppedFrames} display frames dropped during ${t.id}.${s.prop}: main thread blocked`,
        });
      }
    }

    const v = t.visibility;
    if (!v) continue;
    if (v.finalEffectiveOpacity <= 0.01) {
      issues.push({ severity: 'info', code: 'invisible-at-end', target: t.id, message: `"${t.id}" ends fully transparent or hidden` });
      continue;
    }

    const scrolled = t.segments.some((s) => s.prop === 'scrollX' || s.prop === 'scrollY');
    if (v.finalClipRatio < 0.99) {
      issues.push(
        scrolled
          ? {
              severity: 'info',
              code: 'scrolled-out-of-view',
              target: t.id,
              message: `"${t.id}" ends ${pct(v.finalClipRatio)} inside its scroll viewport after scrolling`,
            }
          : {
              severity: 'warning',
              code: 'clipped-at-end',
              target: t.id,
              message: `"${t.id}" ends only ${pct(v.finalClipRatio)} visible: cut off by an ancestor with overflow hidden, or off screen`,
            },
      );
    }
    if (v.finalOccludedRatio > 0.01) {
      issues.push({
        severity: 'warning',
        code: 'occluded-at-end',
        target: t.id,
        message: `"${t.id}" ends ${pct(v.finalOccludedRatio)} covered by views drawn above it (overlay, or a sibling with a higher zIndex)`,
      });
    }

    const motion = t.motion;
    if (motion && v.finalRatio >= 0.99) {
      const clippedWhileMoving = v.clipped.filter((c) => overlaps(c, motion));
      if (clippedWhileMoving.length) {
        const min = Math.min(...clippedWhileMoving.map((c) => c.minRatio));
        issues.push({
          severity: 'info',
          code: 'clipped-during-motion',
          target: t.id,
          message: `"${t.id}" was partly clipped while moving (min ${pct(min)} visible); expected for slide-in/out`,
        });
      }
      const coveredWhileMoving = v.occluded.filter((o) => overlaps(o, motion));
      if (coveredWhileMoving.length) {
        const max = Math.max(...coveredWhileMoving.map((o) => o.maxRatio));
        issues.push({
          severity: 'info',
          code: 'occluded-during-motion',
          target: t.id,
          message: `"${t.id}" was partly covered while moving (up to ${pct(max)})`,
        });
      }
    }
  }
  return issues;
}
