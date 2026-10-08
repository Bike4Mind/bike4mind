// The node:fs half of report.ts. Not exported from index.ts, so the subpath stays fs-free.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LakeRagReport } from './report';

/**
 * Overwrites `path` with the report as JSON. The harness's emitEvalReport appends text to
 * PROMPT_EVAL_REPORT_PATH, so this driver writes the file itself rather than going through it.
 */
export function writeLakeRagReport(path: string, report: LakeRagReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/** Reads a baseline written by writeLakeRagReport; throws if it is not a report. */
export function readLakeRagReport(path: string): LakeRagReport {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !('arms' in parsed) || !('multiLakeDrop' in parsed)) {
    throw new Error(`${path} is not a lake RAG eval report`);
  }
  return parsed as LakeRagReport;
}
