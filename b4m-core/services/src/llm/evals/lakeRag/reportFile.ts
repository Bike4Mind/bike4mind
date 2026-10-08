// The node:fs half of report.ts. Not exported from index.ts, so the subpath stays fs-free.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LakeRagReport } from './report';
import { LAKE_RAG_ARMS } from './run';

/**
 * Overwrites `path` with the report as JSON. The harness's emitEvalReport appends text to
 * PROMPT_EVAL_REPORT_PATH (a sibling harness), so this driver writes the file itself rather than going through it.
 */
export function writeLakeRagReport(path: string, report: LakeRagReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isRate = (v: unknown): boolean => v === null || typeof v === 'number';
const hasRate = (v: unknown): boolean => isRecord(v) && isRate(v.rate);

/**
 * Reads a baseline written by writeLakeRagReport. Checks every field compareLakeRagReports reads,
 * so a truncated or hand-edited baseline fails here by name instead of as a TypeError mid-compare.
 */
export function readLakeRagReport(path: string): LakeRagReport {
  const malformed = (what: string, cause?: unknown) =>
    new Error(`${path} is not a lake RAG eval report: ${what}`, cause === undefined ? undefined : { cause });
  // Read outside the try: a wrong path is a read error, not a malformed report.
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw malformed(err instanceof Error ? err.message : String(err), err);
  }
  if (!isRecord(parsed) || !isRecord(parsed.arms)) throw malformed('missing arms');
  if (!isRate(parsed.multiLakeDrop)) throw malformed('multiLakeDrop is not a number or null');
  for (const arm of LAKE_RAG_ARMS) {
    const report = parsed.arms[arm];
    if (report === undefined) continue;
    if (!isRecord(report) || !hasRate(report.pass) || !hasRate(report.retrieval)) {
      throw malformed(`arm ${arm} lacks pass/retrieval rates`);
    }
  }
  return parsed as LakeRagReport;
}
