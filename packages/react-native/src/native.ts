import { requireOptionalNativeModule } from 'expo';

export interface NativeProbeInfo {
  platform: 'ios' | 'android';
  columns: string[];
  osVersion?: string;
  deviceName?: string;
}

export interface NativeDrain {
  frameOffset: number;
  frameTimes: number[];
  samples: number[][];
  running: boolean;
  endReason: string;
  nominalFrameMs: number;
}

export interface NativeStartResult {
  startedAt: number;
  found: string[];
  missing: string[];
}

export interface MotionProbeNativeModule {
  getInfo(): Promise<NativeProbeInfo>;
  start(
    targets: string[],
    options: { maxDurationMs?: number; resolveEveryFrames?: number; occlusionGrid?: number },
  ): Promise<NativeStartResult>;
  drain(): Promise<NativeDrain>;
  stop(reason: string): Promise<NativeDrain>;
}

/** `null` when the native module is not linked (e.g. Expo Go or a stale build). */
export const MotionProbeNative = requireOptionalNativeModule<MotionProbeNativeModule>('MotionProbe');
