import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
  KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT,
  KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
  SettingScope,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import type { SemanticSearchBudgets } from './semanticDataLakeSearch';
import { resolveScopedSettingValues } from '../settings/resolveScopedSetting';

/**
 * The scan budgets the search engine consumes, plus the SERVE budget its callers need.
 *
 * `maxChunkChars` is deliberately not part of SemanticSearchBudgets: it governs how much of a
 * matched chunk reaches the model, which the engine has no say in, and putting it on the engine's
 * interface would hand it a field it never reads.
 */
export type ResolvedSearchBudgets = SemanticSearchBudgets & {
  /**
   * Characters of one matched chunk the serve path may emit. Derived from the chunk policy rather
   * than configured on its own, so a passage cannot be chunked larger than it can be served.
   */
  maxChunkChars: number;
  /** Passages `search_knowledge_base` serves when a model call omits `max_results` (#1955). */
  kbDefaultResults: number;
  /**
   * Approximate tokens of served passage text one `search_knowledge_base` call may emit. `0` = no
   * budget; the passage count above is then the only bound (pre-#1955 behavior).
   */
  kbResultTokenBudget: number;
  /**
   * Minimum cosine score a passage must clear, as a 0..1 FRACTION - the unit `minScore` takes all
   * the way down to `annVectorSearch`. Stored as an integer percent (`kbSearchMinRelevancePct`);
   * the /100 conversion lives here so exactly one place owns it. `0` = today's behavior.
   */
  kbMinRelevance: number;
};

/**
 * Read the operator-configured budgets for data-lake semantic search: how far to SCAN, how much of
 * a matched chunk to SERVE, and (#1955) how many passages and how relevant they must be for
 * `search_knowledge_base` specifically.
 *
 * Shared by every entrypoint (the search route, the chat KB tool, forced retrieval) so one
 * surface cannot end up scanning further than another. Uses the CACHED settings accessor, so
 * this costs no round-trip on a warm cache.
 *
 * The serve budget is DERIVED from the chunk-size policy (`DefaultChunkSize`, the same row the
 * chunker reads as its passage target) rather than being a lever of its own. Two independently-set
 * numbers is what produced the defect this replaces: content was chunked to one size and clipped at
 * serve time by a smaller constant, so a full-size chunk lost roughly 40% of itself before the model
 * saw it, on every lake. See deriveServeCharBudget in @bike4mind/common.
 *
 * Never throws: a settings outage falls back to the coded defaults and warns. The warn matters
 * because the symptom of a bad value would otherwise be "retrieval quietly covers less than the
 * admin configured", which is indistinguishable from a small corpus.
 *
 * Scope (epic #1658 lane 0 / #1660): callers that know the org/owner/lake a search runs for may pass
 * a `scope` (and the `scopedSettings` overlay repo) to let a narrower rung tighten the budget below
 * the platform ceiling. Omitting both - every caller today - takes the byte-identical platform path
 * below, so this change is additive. Chunk-policy rungs ride this same seam when #1662 gives
 * `DefaultChunkSize` its `scope.settableAt`; the serve budget below picks them up with no edit here.
 */
export async function resolveSearchBudgets(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  },
  logger?: Logger,
  scope?: SettingScope
): Promise<ResolvedSearchBudgets> {
  // Scoped path: only when a caller both supplies rungs and wires the overlay store. The resolver
  // falls back to the platform value per key, so an un-overridden budget matches the platform path.
  if (scope && db.scopedSettings && scopeHasRung(scope)) {
    try {
      const values = await resolveScopedSettingValues(
        // DefaultChunkSize rides along deliberately. It declares no `scope.settableAt`, so
        // computeCandidateRefs yields no rungs for it and it resolves to exactly the platform value -
        // this adds no org/lake lever (that is #1662), it only keeps ONE derivation for both paths.
        // Omitting it here instead would make the scoped path serve a different budget than the
        // platform path for the same lake, which is the disagreement this whole change removes.
        [
          'dataLakeSearchMaxFiles',
          'dataLakeSearchMaxChunks',
          'DefaultChunkSize',
          'kbSearchDefaultResults',
          'kbSearchResultTokenBudget',
          'kbSearchMinRelevancePct',
        ],
        scope,
        db,
        {
          logger,
        }
      );
      return {
        maxFiles: positiveIntOr(values.dataLakeSearchMaxFiles, DATA_LAKE_SEARCH_MAX_FILES_DEFAULT, 'maxFiles', logger),
        maxChunks: positiveIntOr(
          values.dataLakeSearchMaxChunks,
          DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
          'maxChunks',
          logger
        ),
        maxChunkChars: resolveServeBudget(values.DefaultChunkSize, logger),
        kbDefaultResults: positiveIntOr(
          values.kbSearchDefaultResults,
          KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
          'kbSearchDefaultResults',
          logger
        ),
        kbResultTokenBudget: nonNegativeIntOr(
          values.kbSearchResultTokenBudget,
          KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
          'kbSearchResultTokenBudget',
          logger
        ),
        kbMinRelevance: resolveRelevancePct(values.kbSearchMinRelevancePct, logger),
      };
    } catch (err) {
      logger?.warn?.('[semanticSearch] scoped budget resolution failed; falling back to platform', err);
      // fall through to the platform path
    }
  }

  try {
    const values = await getSettingsByNames(
      [
        'dataLakeSearchMaxFiles',
        'dataLakeSearchMaxChunks',
        'DefaultChunkSize',
        'kbSearchDefaultResults',
        'kbSearchResultTokenBudget',
        'kbSearchMinRelevancePct',
      ],
      db,
      { logger }
    );
    return {
      maxFiles: positiveIntOr(values.dataLakeSearchMaxFiles, DATA_LAKE_SEARCH_MAX_FILES_DEFAULT, 'maxFiles', logger),
      maxChunks: positiveIntOr(
        values.dataLakeSearchMaxChunks,
        DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
        'maxChunks',
        logger
      ),
      maxChunkChars: resolveServeBudget(values.DefaultChunkSize, logger),
      kbDefaultResults: positiveIntOr(
        values.kbSearchDefaultResults,
        KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
        'kbSearchDefaultResults',
        logger
      ),
      kbResultTokenBudget: nonNegativeIntOr(
        values.kbSearchResultTokenBudget,
        KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
        'kbSearchResultTokenBudget',
        logger
      ),
      kbMinRelevance: resolveRelevancePct(values.kbSearchMinRelevancePct, logger),
    };
  } catch (err) {
    logger?.warn?.('[semanticSearch] could not read scan-budget settings; using defaults', err);
    return {
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      // No configured target reached us, so the chunker's own default is the honest basis.
      maxChunkChars: deriveServeCharBudget(undefined).maxChunkChars,
      kbDefaultResults: KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
      kbResultTokenBudget: KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
      kbMinRelevance: KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT / 100,
    };
  }
}

/**
 * Turn the configured chunk token target into the serve character budget, warning when the safety
 * ceiling leaves the cap below the configured chunk size - the residual case where the two still
 * disagree, and the one an operator has to be told about rather than discover as truncated answers.
 *
 * Takes `number` as well as `string` because the two paths hand it different shapes: the platform
 * read yields the raw stored string, while the scoped resolver has already parsed the value through
 * the setting's schema. One consequence worth knowing: on the scoped path an unusable stored value is
 * coerced to the coded default before it reaches here, so the set-but-unusable warn below fires only
 * on the platform path. Closing that belongs with the scoped seam itself (#1662), not here.
 */
function resolveServeBudget(rawChunkSize: string | number | null | undefined, logger?: Logger): number {
  // Same parse-and-warn contract as the scan budgets: unset is normal and silent, set-but-unusable
  // warns and falls back to the chunker's own default - which is what the chunker does with it too.
  const target = positiveIntOr(rawChunkSize, DEFAULT_PASSAGE_TOKEN_TARGET, 'DefaultChunkSize', logger);
  const budget = deriveServeCharBudget(target);
  if (budget.ceilingBound && !ceilingWarnedTargets.has(budget.chunkTokenTarget)) {
    ceilingWarnedTargets.add(budget.chunkTokenTarget);
    logger?.warn?.(
      `[semanticSearch] chunk target ${budget.chunkTokenTarget} tokens exceeds the per-passage serve ceiling; ` +
        `serving ${budget.maxChunkChars} chars per chunk, so large chunks will be clipped`
    );
  }
  return budget.maxChunkChars;
}

/**
 * The ceiling warn states a CONFIG fact, not a per-request one, and this resolver sits on the hot chat
 * path (search runs up to MAX_SEARCHES times a turn, for every user). Warning on every call would bury
 * the signal in its own repetition, so it fires once per distinct token target per process. A config
 * change to a new value warns again, which is the only transition an operator needs to see.
 */
const ceilingWarnedTargets = new Set<number>();

/** Test-only: the limiter above is module state, so a test asserting it has to start from a clean slate. */
export function resetServeCeilingWarnLimiter(): void {
  ceilingWarnedTargets.clear();
}

function scopeHasRung(scope: SettingScope): boolean {
  return !!(scope.organizationId || scope.owner?.id || scope.lakeId);
}

/**
 * An unset setting is normal and silent; a set-but-unusable one is a misconfiguration worth saying.
 * Exported so other numeric-setting readers (e.g. forced retrieval's char budget in
 * `ChatCompletionFeatures.ts`) share this parse-and-warn contract instead of hand-rolling a copy.
 */
export function positiveIntOr(
  raw: string | number | null | undefined,
  fallback: number,
  label: string,
  logger?: Logger
): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger?.warn?.(`[semanticSearch] ignoring unusable ${label} setting ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * Sibling of `positiveIntOr` for settings where `0` is a MEANINGFUL value, not an unusable one - a
 * disabled budget or an absent relevance floor. `positiveIntOr` cannot express this: it treats
 * anything below 1 as a misconfiguration and warns, which would fire on every search for a
 * legitimately-zero setting. Same contract otherwise: unset is silent, set-but-unusable warns and
 * falls back.
 */
export function nonNegativeIntOr(
  raw: string | number | null | undefined,
  fallback: number,
  label: string,
  logger?: Logger
): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger?.warn?.(`[semanticSearch] ignoring unusable ${label} setting ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}

/**
 * `kbSearchMinRelevancePct` as a 0..1 fraction. The write-path schema already enforces `max: 100`
 * and the scoped-override path's own schema parse closes it too - this clamp exists only for a
 * platform row written by any OTHER means (a hand-edited DB document, a stale row from before the
 * setting declared `max: 100`). Without it, a value like 500 would divide down to `minScore: 5.0`,
 * a cosine score no real match can ever clear, silently degrading every KB search to keyword-only
 * forever. `nonNegativeIntOr` stays generic (no upper bound - `kbSearchResultTokenBudget` reuses it
 * with a much larger, setting-specific ceiling), so the 100-cap and the /100 conversion live
 * together here, in the one place that already owns the unit conversion.
 */
function resolveRelevancePct(raw: string | number | null | undefined, logger?: Logger): number {
  const pct = nonNegativeIntOr(raw, KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT, 'kbSearchMinRelevancePct', logger);
  if (pct > 100) {
    logger?.warn?.(`[semanticSearch] kbSearchMinRelevancePct ${pct} exceeds 100; clamping`);
    return 1;
  }
  return pct / 100;
}
