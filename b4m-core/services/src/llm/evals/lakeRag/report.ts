/**
 * Aggregates graded turns into the JSON report (pass and retrieval rate per arm and kind, plus the
 * multi-lake drop) and compares two reports against the run-to-run noise band. Pure; the file
 * read/write lives in reportFile.ts.
 */
import { LAKE_RAG_KINDS, type LakeRagKind } from './bank';
import { LAKE_RAG_ARMS, type LakeRagArm, type LakeRagTurn } from './run';

/** `rate` is passed / total, or null when nothing was counted. */
export type LakeRagRate = { passed: number; total: number; rate: number | null };

export type LakeRagArmReport = {
  /** Pass rate over the arm's scored turns. */
  pass: LakeRagRate;
  /** Share of all the arm's turns in which retrieval ran (`detectRetrieval`). */
  retrieval: LakeRagRate;
  /** Per-kind pass rate; null for a kind the arm does not score (`absent` on `plain`). */
  byKind: Record<LakeRagKind, LakeRagRate | null>;
};

export type LakeRagReport = {
  model: string;
  samples: number;
  generatedAt: string;
  arms: Partial<Record<LakeRagArm, LakeRagArmReport>>;
  /** Lake pass rate minus multi-lake pass rate (a fraction); null unless both arms ran. */
  multiLakeDrop: number | null;
  turns: LakeRagTurn[];
};

/**
 * The plain arm has no lake, so an `absent` row ("the lake lacks this") passes near-never by
 * construction. Those turns are reported as n/a rather than dragging the baseline down.
 */
function isScored(turn: Pick<LakeRagTurn, 'arm' | 'kind'>): boolean {
  return !(turn.arm === 'plain' && turn.kind === 'absent');
}

function rateOf(flags: readonly boolean[]): LakeRagRate {
  const passed = flags.filter(Boolean).length;
  return { passed, total: flags.length, rate: flags.length === 0 ? null : passed / flags.length };
}

function armReport(arm: LakeRagArm, turns: readonly LakeRagTurn[]): LakeRagArmReport {
  const scored = turns.filter(isScored);
  const byKind = Object.fromEntries(
    LAKE_RAG_KINDS.map(kind => [
      kind,
      isScored({ arm, kind }) ? rateOf(scored.filter(t => t.kind === kind).map(t => t.grade.passed)) : null,
    ])
  ) as Record<LakeRagKind, LakeRagRate | null>;
  return {
    pass: rateOf(scored.map(t => t.grade.passed)),
    retrieval: rateOf(turns.map(t => t.retrieval.ran)),
    byKind,
  };
}

export function buildLakeRagReport(
  turns: readonly LakeRagTurn[],
  meta: { model: string; samples: number; generatedAt?: string }
): LakeRagReport {
  const arms: LakeRagReport['arms'] = {};
  for (const arm of LAKE_RAG_ARMS) {
    const armTurns = turns.filter(t => t.arm === arm);
    if (armTurns.length > 0) arms[arm] = armReport(arm, armTurns);
  }
  const lake = arms.lake?.pass.rate;
  const multi = arms['multi-lake']?.pass.rate;
  return {
    model: meta.model,
    samples: meta.samples,
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    arms,
    multiLakeDrop: lake == null || multi == null ? null : lake - multi,
    turns: [...turns],
  };
}

/** Allowed absolute run-to-run movement, as fractions (0.1 = 10 percentage points). */
export type LakeRagNoiseBand = { passRate: number; retrievalRate: number; multiLakeDrop: number };

/**
 * Two runs, same model, samples=1. Per-kind rates are deliberately unbanded: with 6 rows per
 * planted kind, one row is 16.7pp.
 */
export const LAKE_RAG_NOISE_BAND: LakeRagNoiseBand = { passRate: 0.1, retrievalRate: 0.05, multiLakeDrop: 0.1 };

export type LakeRagBandCheck = {
  metric: string;
  prev: number | null;
  curr: number | null;
  delta: number | null;
  band: number;
  ok: boolean;
};

export type LakeRagComparison = { withinBand: boolean; checks: LakeRagBandCheck[] };

// Float slack, so a delta of exactly the band (0.3 - 0.2) is not rejected as 0.10000000000000003.
const EPSILON = 1e-9;

function check(metric: string, prev: number | null, curr: number | null, band: number): LakeRagBandCheck | null {
  if (prev === null && curr === null) return null;
  // A metric present on one side only (an arm that stopped running) is a failure, not a skip.
  if (prev === null || curr === null) return { metric, prev, curr, delta: null, band, ok: false };
  const delta = curr - prev;
  return { metric, prev, curr, delta, band, ok: Math.abs(delta) <= band + EPSILON };
}

/** Compares `curr` to a baseline `prev`: overall pass rate per arm, lake retrieval rates, multi-lake drop. */
export function compareLakeRagReports(
  prev: Pick<LakeRagReport, 'arms' | 'multiLakeDrop'>,
  curr: Pick<LakeRagReport, 'arms' | 'multiLakeDrop'>,
  band: LakeRagNoiseBand = LAKE_RAG_NOISE_BAND
): LakeRagComparison {
  const checks = [
    ...LAKE_RAG_ARMS.map(arm =>
      check(`${arm}.pass`, prev.arms[arm]?.pass.rate ?? null, curr.arms[arm]?.pass.rate ?? null, band.passRate)
    ),
    ...(['lake', 'multi-lake'] as const).map(arm =>
      check(
        `${arm}.retrieval`,
        prev.arms[arm]?.retrieval.rate ?? null,
        curr.arms[arm]?.retrieval.rate ?? null,
        band.retrievalRate
      )
    ),
    check('multiLakeDrop', prev.multiLakeDrop, curr.multiLakeDrop, band.multiLakeDrop),
  ].filter((c): c is LakeRagBandCheck => c !== null);
  return { withinBand: checks.every(c => c.ok), checks };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function rateText(rate: LakeRagRate | null): string {
  return rate === null ? 'n/a' : `${rate.passed}/${rate.total} (${pct(rate.rate)})`;
}

/** The text summary the live run prints to stdout; the JSON report is the full record. */
export function formatLakeRagReport(report: LakeRagReport, comparison?: LakeRagComparison): string {
  const lines = [`lake RAG eval: ${report.model} @ ${report.samples} sample(s) per question`];
  for (const arm of LAKE_RAG_ARMS) {
    const a = report.arms[arm];
    if (!a) continue;
    const kinds = LAKE_RAG_KINDS.map(kind => `${kind} ${rateText(a.byKind[kind])}`).join(', ');
    lines.push(`  ${arm}: pass ${rateText(a.pass)}, retrieval ${rateText(a.retrieval)}; ${kinds}`);
  }
  const drop = report.multiLakeDrop;
  lines.push(`  multi-lake drop: ${drop === null ? 'n/a' : `${(drop * 100).toFixed(1)}pp`}`);
  if (comparison) {
    const out = comparison.checks.filter(c => !c.ok);
    lines.push(
      out.length === 0
        ? '  baseline: within the noise band'
        : `  baseline: OUT OF BAND ${out.map(c => `${c.metric} ${pct(c.prev)} -> ${pct(c.curr)}`).join(', ')}`
    );
  }
  for (const t of report.turns.filter(t => isScored(t) && !t.grade.passed)) {
    lines.push(`  FAIL ${t.arm} ${t.rowId}#${t.sample}: ${t.grade.reason}`);
  }
  return lines.join('\n');
}
