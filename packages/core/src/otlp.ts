import type { MotionReport } from './schema.js';

type AttributeValue = { stringValue: string } | { doubleValue: number } | { intValue: string } | { boolValue: boolean };
interface Attribute {
  key: string;
  value: AttributeValue;
}

function attr(key: string, v: string | number | boolean): Attribute {
  if (typeof v === 'string') return { key, value: { stringValue: v } };
  if (typeof v === 'boolean') return { key, value: { boolValue: v } };
  return Number.isInteger(v) ? { key, value: { intValue: String(v) } } : { key, value: { doubleValue: v } };
}

function randomHex(bytes: number): string {
  let out = '';
  for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return out;
}

/**
 * OTLP/JSON (`ExportTraceServiceRequest`) so motion reports can be sent to the same collector as
 * other UX telemetry: one root span per recording, a span per target, and a span per animation.
 */
export function toOtlpJson(report: MotionReport, options: { serviceName?: string } = {}) {
  const traceId = randomHex(16);
  const rootId = randomHex(8);
  const nanos = (offsetMs: number) => (BigInt(Math.round((report.startedAt + offsetMs) * 1000)) * 1000n).toString();

  const spans: object[] = [
    {
      traceId,
      spanId: rootId,
      name: 'motion-probe.record',
      kind: 1,
      startTimeUnixNano: nanos(0),
      endTimeUnixNano: nanos(report.durationMs),
      attributes: [
        attr('motion.platform', report.platform),
        attr('motion.end_reason', report.endReason),
        attr('motion.fps', report.frames.fps),
        attr('motion.dropped_frames', report.frames.droppedFrames),
      ],
    },
  ];

  for (const target of report.targets) {
    const targetId = randomHex(8);
    const window = target.motion ?? target.presence[0] ?? { startMs: 0, endMs: report.durationMs };
    const v = target.visibility;
    spans.push({
      traceId,
      spanId: targetId,
      parentSpanId: rootId,
      name: `target ${target.id}`,
      kind: 1,
      startTimeUnixNano: nanos(window.startMs),
      endTimeUnixNano: nanos(window.endMs),
      attributes: [
        attr('motion.target', target.id),
        attr('motion.found', target.found),
        ...(v
          ? [
              attr('motion.visible.min_ratio', v.minRatio),
              attr('motion.visible.final_ratio', v.finalRatio),
              attr('motion.visible.final_clip_ratio', v.finalClipRatio),
              attr('motion.visible.final_occluded_ratio', v.finalOccludedRatio),
            ]
          : []),
      ],
      events: [
        ...(v?.clipped ?? []).map((c) => ({
          name: 'motion.clipped',
          timeUnixNano: nanos(c.startMs),
          attributes: [attr('motion.clipped.end_ms', c.endMs), attr('motion.clipped.min_ratio', c.minRatio)],
        })),
        ...(v?.occluded ?? []).map((o) => ({
          name: 'motion.occluded',
          timeUnixNano: nanos(o.startMs),
          attributes: [attr('motion.occluded.end_ms', o.endMs), attr('motion.occluded.max_ratio', o.maxRatio)],
        })),
      ],
    });

    for (const s of target.segments) {
      spans.push({
        traceId,
        spanId: randomHex(8),
        parentSpanId: targetId,
        name: `animate ${s.prop}`,
        kind: 1,
        startTimeUnixNano: nanos(s.startMs),
        endTimeUnixNano: nanos(s.endMs),
        attributes: [
          attr('motion.target', target.id),
          attr('motion.prop', s.prop),
          attr('motion.kind', s.kind),
          attr('motion.from', s.from),
          attr('motion.to', s.to),
          attr('motion.duration_ms', s.durationMs),
          attr('motion.settle_ms', s.settleMs),
          attr('motion.overshoot_pct', s.overshootPct),
          attr('motion.dropped_frames', s.droppedFrames),
          attr('motion.stalls', s.stalls.length),
          ...(s.easing ? [attr('motion.easing', s.easing.name), attr('motion.easing.bezier', s.easing.bezier.join(','))] : []),
          ...(s.spring?.dampingRatio !== undefined ? [attr('motion.spring.damping_ratio', s.spring.dampingRatio)] : []),
        ],
        events: s.stalls.map((stall) => ({
          name: 'motion.stall',
          timeUnixNano: nanos(stall.startMs),
          attributes: [attr('motion.stall.duration_ms', stall.durationMs), attr('motion.stall.frames', stall.frames)],
        })),
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            attr('service.name', options.serviceName ?? report.app?.name ?? 'motion-probe'),
            attr('os.type', report.platform),
            ...(report.app?.osVersion ? [attr('os.version', report.app.osVersion)] : []),
            ...(report.app?.deviceName ? [attr('device.model.name', report.app.deviceName)] : []),
          ],
        },
        scopeSpans: [{ scope: { name: 'motion-probe', version: '0.1.0' }, spans }],
      },
    ],
  };
}
