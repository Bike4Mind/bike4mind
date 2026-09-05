/**
 * The configuration sweep for the `search_knowledge_base` recall probe (#1993).
 *
 * Pure: parsing and formatting only, so the shape of a sweep and the shape of its report are
 * testable without a database, an embedding key, or a stage. The live driver is `recall-probe.ts`.
 */

import type { Aggregate } from './metrics';

/**
 * One point in the sweep. Both knobs are admin settings introduced by #1955 (PR #2009).
 *
 * `tokenBudget` is `kbSearchResultTokenBudget`: approximate tokens of served passage text one call
 * may emit. `minRelevancePct` is `kbSearchMinRelevancePct`: a whole-number percent, converted to the
 * 0..1 cosine fraction by `resolveSearchBudgets`. Zero disables each knob independently, and
 * `{0, 0}` is today's shipped default - byte-identical to pre-#1955 retrieval, which is why every
 * sweep must include it as its baseline row.
 */
export type SweepConfig = {
  tokenBudget: number;
  minRelevancePct: number;
};

/** Today's shipped defaults. Both knobs off; retrieval is byte-identical to pre-#1955. */
export const BASELINE_CONFIG: SweepConfig = { tokenBudget: 0, minRelevancePct: 0 };

export const formatConfig = (c: SweepConfig): string => `budget=${c.tokenBudget} floor=${c.minRelevancePct}%`;

/**
 * The write-time ceiling `kbSearchResultTokenBudget` declares (`common/src/schemas/settings.ts`),
 * enforced there only by the settings API's `schema.parse`. This script writes the model directly
 * and bypasses that, so without this bound `--configs=50000:0` produces a table row for a value an
 * admin could never save - and one that is measurement-identical to 20000 anyway, since the tool's
 * passage ceiling binds first above it.
 */
const MAX_TOKEN_BUDGET = 20_000;

/**
 * Parse `--configs=0:0,4000:0,4000:60` into sweep points ("tokenBudget:minRelevancePct").
 *
 * Throws rather than skipping a malformed entry: a silently dropped configuration would produce a
 * results table that looks complete and is missing the row someone asked for. That is also why the
 * component count is checked exactly - `Number('')` is 0 and `Number.isInteger(0)` is true, so
 * "4000:" would otherwise parse as a floor of 0 and "4000:70:80" would drop its third segment,
 * both landing a row that quietly is not the one that was asked for.
 */
export function parseConfigs(spec: string): SweepConfig[] {
  const configs = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const components = part.split(':');
      if (components.length !== 2) {
        throw new Error(
          `Bad configuration "${part}": expected exactly "tokenBudget:minRelevancePct", got ${components.length} component(s)`
        );
      }
      const [budget, floor] = components;
      const tokenBudget = Number(budget);
      const minRelevancePct = Number(floor);
      if (budget.trim() === '' || !Number.isInteger(tokenBudget) || tokenBudget < 0) {
        throw new Error(`Bad token budget in "${part}": expected a non-negative integer, got "${budget}"`);
      }
      if (tokenBudget > MAX_TOKEN_BUDGET) {
        throw new Error(
          `Token budget ${tokenBudget} in "${part}" exceeds the ${MAX_TOKEN_BUDGET} ceiling ` +
            `kbSearchResultTokenBudget declares, so no admin could deploy the result.`
        );
      }
      if (floor.trim() === '') {
        throw new Error(`Bad relevance floor in "${part}": expected an integer percent 0-100, got ""`);
      }
      if (!Number.isInteger(minRelevancePct) || minRelevancePct < 0 || minRelevancePct > 100) {
        throw new Error(`Bad relevance floor in "${part}": expected an integer percent 0-100, got "${floor}"`);
      }
      return { tokenBudget, minRelevancePct };
    });
  if (configs.length === 0) throw new Error('--configs listed no configurations');

  const seen = new Set<string>();
  for (const c of configs) {
    const key = formatConfig(c);
    // A repeated point would run the whole question set twice and print two rows that can only
    // differ by noise, which reads as instability in the measurement rather than a duplicated input.
    if (seen.has(key)) throw new Error(`Duplicate configuration in --configs: ${key}`);
    seen.add(key);
  }
  return configs;
}

export type SweepRow = SweepConfig & { aggregate: Aggregate };

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * Precision carries its own denominator, because it is the one column whose denominator MOVES with
 * the configuration: positives that served nothing are excluded from it (see `Aggregate.precision`
 * for why), so one row's precision is only comparable to another's alongside the `n` it was
 * averaged over - a rising precision on a shrinking `n` is a floor emptying questions, not a floor
 * improving the result set. With no scored positive at all there is no precision to state: "n/a"
 * rather than the 0.0% an empty mean prints, which would read as a collapse instead of an absence.
 */
const precisionCell = (a: Aggregate): string =>
  a.precisionScored === 0 ? 'n/a (n=0)' : `${pct(a.precision)} (n=${a.precisionScored})`;

/**
 * Render the sweep as a Markdown table for pasting into the ticket.
 *
 * Every column is here because it can independently change the decision: recall is the goal,
 * precision and falsePositiveRate are what a wider budget or a lower floor costs, and docs/q is the
 * figure #1831 led with. Reporting recall alone is what "more passages is not automatically better"
 * warns against.
 */
export function formatSweepTable(rows: readonly SweepRow[]): string {
  const header = [
    '| token budget | floor | recall | precision | hit rate | MRR | docs/q | false-positive rate |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const body = rows.map(r =>
    [
      '',
      r.tokenBudget === 0 ? 'off' : String(r.tokenBudget),
      r.minRelevancePct === 0 ? 'off' : `${r.minRelevancePct}%`,
      pct(r.aggregate.recall),
      precisionCell(r.aggregate),
      pct(r.aggregate.hitRate),
      r.aggregate.mrr.toFixed(3),
      r.aggregate.meanDocumentsServed.toFixed(1),
      pct(r.aggregate.falsePositiveRate),
      '',
    ].join(' | ')
  );
  return [...header, ...body].join('\n');
}
