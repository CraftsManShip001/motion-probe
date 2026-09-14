import { beforeEach, describe, expect, it, vi } from 'vitest';

const FRAME_MS = 1000 / 60;
const FRAMES_PER_DRAIN = 6;

/** Fake native probe: produces one target's frames on each drain, like the Swift/Kotlin recorders. */
const native = vi.hoisted(() => {
  const COLUMNS = [
    'frame', 'target', 'present', 'x', 'y', 'width', 'height', 'boundsWidth', 'boundsHeight',
    'translateX', 'translateY', 'scaleX', 'scaleY', 'rotation', 'opacity', 'effectiveOpacity', 'visibleRatio',
  ];
  const state = {
    valueAt: (_t: number): number | null => 0,
    maxFrames: Infinity,
    frames: 0,
    last: undefined as string | undefined,
    running: false,
    endReason: '',
    stopReasons: [] as string[],
  };

  const produce = (count: number) => {
    const frameOffset = state.frames;
    const frameTimes: number[] = [];
    const samples: number[][] = [];
    for (let k = 0; k < count && state.running; k++) {
      const frame = state.frames++;
      const t = frame * (1000 / 60);
      frameTimes.push(t);
      const v = state.valueAt(t);
      const row = [frame, 0, v === null ? 0 : 1, 0, 0, 44, 44, 44, 44, v ?? 0, 0, 1, 1, 0, 1, 1, 1];
      const key = JSON.stringify(row.slice(2));
      if (key !== state.last && (state.last !== undefined || v !== null)) samples.push(row);
      state.last = key;
      if (state.frames >= state.maxFrames) {
        state.running = false;
        state.endReason = 'maxDuration';
      }
    }
    return { frameOffset, frameTimes, samples, running: state.running, endReason: state.endReason, nominalFrameMs: 1000 / 60 };
  };

  const module = {
    getInfo: async () => ({ platform: 'ios' as const, columns: COLUMNS, osVersion: '26.5', deviceName: 'fake' }),
    start: async (targets: string[]) => {
      Object.assign(state, { frames: 0, last: undefined, running: true, endReason: '' });
      return { startedAt: 1_700_000_000_000, found: targets, missing: [] };
    },
    drain: async () => produce(6),
    stop: async (reason: string) => {
      state.stopReasons.push(reason);
      if (state.running) state.endReason = reason;
      const result = produce(0);
      state.running = false;
      return { ...result, running: false };
    },
  };
  return { state, module };
});

vi.mock('../src/native', () => ({ MotionProbeNative: native.module }));

const { startRecording } = await import('../src/recorder');

beforeEach(() => {
  native.state.valueAt = () => 0;
  native.state.maxFrames = Infinity;
  native.state.stopReasons = [];
});

describe('startRecording', () => {
  it('stops once motion has settled for idleMs and returns a complete raw trace', async () => {
    native.state.valueAt = (t) => (t < 200 ? 0 : t < 500 ? ((t - 200) / 300) * 100 : 100);
    const recording = startRecording(['box'], { idleMs: 300, pollMs: 2 });

    await expect(recording.armed).resolves.toMatchObject({ found: ['box'] });
    const trace = await recording.done;

    expect(trace.endReason).toBe('settled');
    expect(trace.schema).toBe('motion-probe/raw-trace@1');
    expect(trace.targets).toEqual(['box']);
    expect(trace.frameTimes.length % FRAMES_PER_DRAIN).toBe(0);
    const last = trace.frameTimes[trace.frameTimes.length - 1];
    expect(last).toBeGreaterThanOrEqual(500 + 300 - FRAME_MS);
    expect(last).toBeLessThan(500 + 300 + FRAMES_PER_DRAIN * FRAME_MS * 2);
    // Frame indices in samples line up with frameTimes.
    expect(Math.max(...trace.samples.map((row) => row[0]))).toBeLessThan(trace.frameTimes.length);
    expect(native.state.stopReasons).toEqual(['settled']);
  });

  it('times out when nothing moves', async () => {
    const trace = await startRecording(['box'], { timeoutMs: 400, pollMs: 2 }).done;
    expect(trace.endReason).toBe('timeout');
    expect(trace.samples).toHaveLength(1);
  });

  it('treats a view mounting after arm as the start of motion', async () => {
    native.state.valueAt = (t) => (t < 150 ? null : 0);
    const trace = await startRecording(['sheet'], { idleMs: 200, pollMs: 2 }).done;
    expect(trace.endReason).toBe('settled');
    expect(trace.samples[0][0]).toBeGreaterThan(0);
  });

  it('can be cancelled', async () => {
    const recording = startRecording(['box'], { pollMs: 2 });
    await recording.armed;
    recording.cancel();
    await expect(recording.done).resolves.toMatchObject({ endReason: 'cancelled' });
  });

  it('reports the native cap when motion never settles', async () => {
    native.state.valueAt = (t) => Math.sin(t / 50) * 20;
    native.state.maxFrames = 36;
    const trace = await startRecording(['spinner'], { pollMs: 2 }).done;
    expect(trace.endReason).toBe('maxDuration');
    expect(trace.frameTimes).toHaveLength(36);
  });
});
