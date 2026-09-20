/**
 * The configuration sweep for the `search_knowledge_base` recall probe (#1993).
 *
 * Pure: parsing and formatting only, so the shape of a sweep and the shape of its report are
 * testable without a database, an embedding key, or a stage. The live driver is `recall-probe.ts`.
 */

import { KB_SEARCH_DEFAULT_RESULTS_DEFAULT } from '@bike4mind/common';
import type { ClaimAggregate } from './claimAudit';
import type { Aggregate } from './metrics';

/**
 * One point in the sweep. All three knobs are admin settings introduced by #1955 (PR #2009), and all
 * three belong to the `search_knowledge_base` TOOL path - forced retrieval reads none of them. Its
 * own two floors are swept offline instead; see `recall-probe.ts`' header for why the two
 * instruments are separate rather than five columns of one table.
 *
 * `tokenBudget` is `kbSearchResultTokenBudget`: approximate tokens of served passage text one call
 * may emit. `minRelevancePct` is `kbSearchMinRelevancePct`: a whole-number percent, converted to the
 * 0..1 cosine fraction by `resolveSearchBudgets`. Zero disables each of those two independently.
 *
 * `defaultResults` is `kbSearchDefaultResults`, swept because the baseline row showed it BINDING:
 * 3.1 documents served per question against a passage default of 5 means the other two knobs were
 * never what limited the result set, so a budget sweep that held it fixed would have been measuring
 * a bound that was not the active one. It has no "off" value - 1 is the setting's own minimum - so
 * the baseline point carries the shipped 5 rather than a 0.
 */
export type SweepConfig = {
  tokenBudget: number;
  minRelevancePct: number;
  defaultResults: number;
};

/**
 * Today's shipped defaults: both budget knobs off and the passage default at its shipped value, so
 * retrieval is byte-identical to pre-#1955. Read from the constant rather than restated, so
 * changing the shipped default (the point of this ticket) cannot leave the baseline row naming a
 * value the product no longer uses.
 */
export const BASELINE_CONFIG: SweepConfig = {
  tokenBudget: 0,
  minRelevancePct: 0,
  defaultResults: KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
};

export const formatConfig = (c: SweepConfig): string =>
  `budget=${c.tokenBudget} floor=${c.minRelevancePct}% results=${c.defaultResults}`;

/**
 * The baseline point as a `--configs` string, so the driver's CLI default is generated from
 * `BASELINE_CONFIG` rather than typed alongside it - a literal default would silently keep the old
 * two-component arity and fail its own parser.
 */
export const formatBaselineSpec = (): string =>
  `${BASELINE_CONFIG.tokenBudget}:${BASELINE_CONFIG.minRelevancePct}:${BASELINE_CONFIG.defaultResults}`;

/**
 * The write-time ceiling `kbSearchResultTokenBudget` declares (`common/src/schemas/settings.ts`),
 * enforced there only by the settings API's `schema.parse`. This script writes the model directly
 * and bypasses that, so without this bound `--configs=50000:0` produces a table row for a value an
 * admin could never save - and one that is measurement-identical to 20000 anyway, since the tool's
 * passage ceiling binds first above it.
 */
const MAX_TOKEN_BUDGET = 20_000;

/**
 * The bounds `kbSearchDefaultResults` declares (`common/src/schemas/settings.ts`), mirrored here for
 * the same reason as `MAX_TOKEN_BUDGET`: this script writes the model directly and never sees that
 * schema's `parse`. The maximum is also the tool's own hard passage ceiling
 * (`KB_SEARCH_MAX_RESULTS`), so a higher value would clamp back down and print a row measuring 10
 * under another number's name. The minimum is 1 because zero results is not a narrower search, it
 * is a disabled one, and the sweep has no reason to measure that.
 */
const MIN_DEFAULT_RESULTS = 1;
const MAX_DEFAULT_RESULTS = 10;

/** The component layout of one `--configs` entry, named so the arity error can state it verbatim. */
const CONFIG_SPEC = 'tokenBudget:minRelevancePct:defaultResults';

/**
 * Parse `--configs=0:0:5,4000:0:10,4000:60:10` into sweep points (`CONFIG_SPEC`).
 *
 * Throws rather than skipping a malformed entry: a silently dropped configuration would produce a
 * results table that looks complete and is missing the row someone asked for. That is also why the
 * component count is checked exactly - `Number('')` is 0 and `Number.isInteger(0)` is true, so
 * "4000:" would otherwise parse as a floor of 0 and "4000:70:80:90" would drop its fourth segment,
 * both landing a row that quietly is not the one that was asked for.
 *
 * The arity went from two to three when `defaultResults` was added, and deliberately did NOT gain a
 * default for the new component. A two-component entry now ERRORS instead of meaning "and the
 * shipped passage default", because the whole finding that motivated sweeping this knob is that its
 * value was the active bound while nobody was stating it - so an entry that does not state it is
 * exactly the entry this sweep must refuse.
 */
export function parseConfigs(spec: string): SweepConfig[] {
  const configs = spec
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      const components = part.split(':');
      if (components.length !== 3) {
        throw new Error(
          `Bad configuration "${part}": expected exactly "${CONFIG_SPEC}", got ${components.length} component(s)`
        );
      }
      const [budget, floor, results] = components;
      const tokenBudget = Number(budget);
      const minRelevancePct = Number(floor);
      const defaultResults = Number(results);
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
      if (results.trim() === '') {
        throw new Error(
          `Bad passage default in "${part}": expected an integer ` +
            `${MIN_DEFAULT_RESULTS}-${MAX_DEFAULT_RESULTS}, got ""`
        );
      }
      if (
        !Number.isInteger(defaultResults) ||
        defaultResults < MIN_DEFAULT_RESULTS ||
        defaultResults > MAX_DEFAULT_RESULTS
      ) {
        throw new Error(
          `Bad passage default in "${part}": expected an integer ` +
            `${MIN_DEFAULT_RESULTS}-${MAX_DEFAULT_RESULTS}, got "${results}"`
        );
      }
      return { tokenBudget, minRelevancePct, defaultResults };
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

/**
 * `claims` is absent when the run was launched with the claim arm off (`--no-claim-audit`), which
 * needs a judge credential the recall arm does not. Optional rather than zero-valued: a row with no
 * claim measurement must render as absent, never as a 0% unverifiable rate, which is the single
 * most flattering number in the table.
 */
export type SweepRow = SweepConfig & { aggregate: Aggregate; claims?: ClaimAggregate };

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
 * The unverifiable-claim rate over its own pooled-claim denominator, for the same reason precision
 * carries one: the denominator MOVES with the configuration, since a question that abstained or was
 * served nothing contributes no claims. A rate rising on a collapsing claim count is a
 * configuration answering less, not answering worse.
 *
 * "n/a" and never 0.0% with no claims to score - see `SweepRow.claims`.
 */
const unverifiableCell = (c: ClaimAggregate): string =>
  c.claims === 0 ? 'n/a (n=0)' : `${pct(c.unverifiableRate)} (n=${c.claims})`;

/**
 * Render the sweep as a Markdown table for pasting into the ticket.
 *
 * Every column is here because it can independently change the decision: recall is the goal,
 * precision and falsePositiveRate are what a wider budget or a lower floor costs, and docs/q is the
 * figure #1831 led with. Reporting recall alone is what "more passages is not automatically better"
 * warns against. docs/q is read against the `results` column specifically: docs/q sitting BELOW
 * `results` means the passage default was not the binding bound at that point, and docs/q pinned AT
 * it means it was.
 *
 * The claim columns are the only ones that can get WORSE as the budget widens, which is what makes
 * them the ones that actually bound the decision - see `claimAudit.ts`. They appear only when the
 * run measured them. `abstained` and `served nothing` sit beside the rate because they are its
 * missing denominator: a configuration can post a fine unverifiable rate by answering almost
 * nothing, and those two columns are where that shows.
 */
export function formatSweepTable(rows: readonly SweepRow[]): string {
  // Driven by the data rather than a parameter: the claim arm is one run-wide flag, so either every
  // row has a claim measurement or none does, and a header promising columns no row can fill would
  // read as a measurement that came back empty.
  const withClaims = rows.some(r => r.claims !== undefined);
  const columns = [
    'token budget',
    'floor',
    'results',
    'recall',
    'precision',
    'hit rate',
    'MRR',
    'docs/q',
    'false-positive rate',
    ...(withClaims ? ['unverifiable', 'abstained', 'served nothing'] : []),
  ];
  const header = [`| ${columns.join(' | ')} |`, `|${columns.map(() => '---:|').join('')}`];
  const body = rows.map(r =>
    [
      '',
      r.tokenBudget === 0 ? 'off' : String(r.tokenBudget),
      r.minRelevancePct === 0 ? 'off' : `${r.minRelevancePct}%`,
      // Never "off": 1 is this setting's floor, so every value here is a real bound. Printing it
      // plainly is the point - the baseline's 3.1 docs/q was read against an unstated 5.
      String(r.defaultResults),
      pct(r.aggregate.recall),
      precisionCell(r.aggregate),
      pct(r.aggregate.hitRate),
      r.aggregate.mrr.toFixed(3),
      r.aggregate.meanDocumentsServed.toFixed(1),
      pct(r.aggregate.falsePositiveRate),
      ...(withClaims
        ? [
            r.claims ? unverifiableCell(r.claims) : 'n/a',
            r.claims ? String(r.claims.skipped.abstained) : 'n/a',
            r.claims ? String(r.claims.skipped['served-nothing']) : 'n/a',
          ]
        : []),
      '',
    ].join(' | ')
  );
  return [...header, ...body].join('\n');
}
