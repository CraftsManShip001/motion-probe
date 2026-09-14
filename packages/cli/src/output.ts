import { readFile, writeFile } from 'node:fs/promises';
import {
  createBaselineSpec,
  evaluate,
  formatAssertions,
  formatReport,
  summarize,
  toOtlpJson,
  type AssertionReport,
  type MotionReport,
  type MotionSpec,
  type RawTrace,
} from '@motion-probe/core';
import { CliError } from './api.js';

export type Format = 'text' | 'json' | 'otlp';

export function parseFormat(value: string | undefined): Format {
  const format = value ?? 'text';
  if (format !== 'text' && format !== 'json' && format !== 'otlp') {
    throw new CliError(`unknown format "${format}" (text | json | otlp)`);
  }
  return format;
}

export async function loadJson<T>(path: string, what: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    throw new CliError(`cannot read ${what} ${path}: ${(error as Error).message}`);
  }
}

export function validateSpec(spec: MotionSpec, source = 'spec'): MotionSpec {
  if (!spec || !Array.isArray(spec.expectations)) throw new CliError(`${source} has no "expectations" array`);
  return spec;
}

export async function loadSpec(path: string): Promise<MotionSpec> {
  return validateSpec(await loadJson<MotionSpec>(path, 'spec'), path);
}

export const specTargets = (spec: MotionSpec) => [...new Set(spec.expectations.map((e) => e.target))];

export interface Analysis {
  report: MotionReport;
  assertions?: AssertionReport;
  /** 1 when a spec was given and failed, else 0. */
  exitCode: number;
}

export function analyzeTrace(trace: RawTrace, options: { spec?: MotionSpec; gapMs?: number } = {}): Analysis {
  const report = summarize(trace, { gapMs: options.gapMs });
  const assertions = options.spec ? evaluate(report, options.spec) : undefined;
  return { report, assertions, exitCode: assertions && !assertions.pass ? 1 : 0 };
}

export function render({ report, assertions }: Analysis, format: Format): string {
  if (format === 'otlp') return JSON.stringify(toOtlpJson(report));
  if (format === 'json') return JSON.stringify(assertions ? { report, assertions } : { report });
  return assertions ? `${formatReport(report)}\n\n${formatAssertions(assertions)}` : formatReport(report);
}

export async function exportOtlp(report: MotionReport, endpoint: string): Promise<void> {
  const url = endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toOtlpJson(report)),
    });
  } catch (error) {
    throw new CliError(`OTLP export to ${url} failed: ${String((error as Error).cause ?? error)}`);
  }
  if (!res.ok) throw new CliError(`OTLP export to ${url} failed: ${res.status} ${await res.text()}`);
}

export interface EmitOptions {
  format: Format;
  spec?: MotionSpec;
  gapMs?: number;
  /** Write the raw trace here. */
  save?: string;
  /** Write a baseline spec generated from this recording here. */
  writeBaseline?: string;
  otlpEndpoint?: string;
}

/** Analyzes a trace, writes side outputs, prints the report to stdout and returns the exit code. */
export async function emit(trace: RawTrace, options: EmitOptions): Promise<number> {
  if (options.save) {
    await writeFile(options.save, JSON.stringify(trace));
    console.error(`raw trace saved to ${options.save}`);
  }
  const analysis = analyzeTrace(trace, { spec: options.spec, gapMs: options.gapMs });
  if (options.writeBaseline) {
    await writeFile(options.writeBaseline, `${JSON.stringify(createBaselineSpec(analysis.report), null, 2)}\n`);
    console.error(`baseline spec written to ${options.writeBaseline}`);
  }
  if (options.otlpEndpoint) {
    await exportOtlp(analysis.report, options.otlpEndpoint);
    console.error(`exported OTLP traces to ${options.otlpEndpoint}`);
  }
  process.stdout.write(`${render(analysis, options.format)}\n`);
  return analysis.exitCode;
}
