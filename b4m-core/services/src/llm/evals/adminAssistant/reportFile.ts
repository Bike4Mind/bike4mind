// The node:fs half of report.ts, kept apart so report.ts stays pure.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AdminEvalReport } from './report';

/** Overwrites `path` with the report as JSON. */
export function writeAdminEvalReport(path: string, report: AdminEvalReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}
