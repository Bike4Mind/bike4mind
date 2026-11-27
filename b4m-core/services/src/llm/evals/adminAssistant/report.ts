/** Aggregates graded turns into per-category pass rates and the text summary. Pure; fs lives in reportFile.ts. */
import { ADMIN_EVAL_CATEGORIES, type AdminEvalCategory } from './cases';
import type { AdminEvalTurn } from './run';

/** `rate` is passed / total, or null when nothing was counted. */
export type AdminEvalRate = { passed: number; total: number; rate: number | null };

export type AdminEvalReport = {
  model: string;
  samples: number;
  /** Rows x samples. `overall.total` below this means a partial run, not a baseline. */
  expectedTurns: number;
  complete: boolean;
  generatedAt: string;
  overall: AdminEvalRate;
  byCategory: Record<AdminEvalCategory, AdminEvalRate>;
  failures: { rowId: string; category: AdminEvalCategory; sample: number; reason: string; toolsCalled: string[] }[];
};

function rateOf(turns: readonly AdminEvalTurn[]): AdminEvalRate {
  const passed = turns.filter(t => t.grade.passed).length;
  return { passed, total: turns.length, rate: turns.length === 0 ? null : passed / turns.length };
}

/** Quest and session ids are deliberately left out of the report. */
export function buildAdminEvalReport(
  turns: readonly AdminEvalTurn[],
  meta: { model: string; samples: number; expectedTurns: number; now?: () => Date }
): AdminEvalReport {
  return {
    model: meta.model,
    samples: meta.samples,
    expectedTurns: meta.expectedTurns,
    complete: turns.length >= meta.expectedTurns,
    generatedAt: (meta.now ?? (() => new Date()))().toISOString(),
    overall: rateOf(turns),
    byCategory: Object.fromEntries(
      ADMIN_EVAL_CATEGORIES.map(c => [c, rateOf(turns.filter(t => t.category === c))])
    ) as Record<AdminEvalCategory, AdminEvalRate>,
    failures: turns
      .filter(t => !t.grade.passed)
      .map(t => ({
        rowId: t.rowId,
        category: t.category,
        sample: t.sample,
        reason: t.grade.reason,
        toolsCalled: t.toolsCalled,
      })),
  };
}

const pct = (r: AdminEvalRate) => (r.rate === null ? 'n/a' : `${Math.round(r.rate * 100)}%`);

export function formatAdminEvalReport(report: AdminEvalReport): string {
  const row = (label: string, r: AdminEvalRate) =>
    `  ${label.padEnd(13)} ${pct(r).padStart(4)}  (${r.passed}/${r.total})`;
  return [
    `Admin assistant eval: ${report.model}, ${report.samples} sample(s) per question`,
    ...(report.complete
      ? []
      : [`PARTIAL RUN: ${report.overall.total} of ${report.expectedTurns} turns; not a baseline`]),
    ...ADMIN_EVAL_CATEGORIES.map(c => row(c, report.byCategory[c])),
    row('overall', report.overall),
    ...(report.failures.length > 0
      ? [
          '',
          'Failing turns:',
          ...report.failures.map(
            f =>
              `  ${f.rowId}#${f.sample}: ${f.reason}${f.toolsCalled.length ? ` [tools: ${f.toolsCalled.join(',')}]` : ''}`
          ),
        ]
      : []),
  ].join('\n');
}
