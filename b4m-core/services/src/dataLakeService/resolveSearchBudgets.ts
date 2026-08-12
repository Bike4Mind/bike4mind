import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  DEFAULT_PASSAGE_TOKEN_TARGET,
  IAdminSettingsRepository,
  deriveServeCharBudget,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import type { SemanticSearchBudgets } from './semanticDataLakeSearch';

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
};

/**
 * Read the operator-configured budgets for data-lake semantic search: how far to SCAN, and how much
 * of a matched chunk to SERVE.
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
 */
export async function resolveSearchBudgets(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: Logger
): Promise<ResolvedSearchBudgets> {
  try {
    const values = await getSettingsByNames(
      ['dataLakeSearchMaxFiles', 'dataLakeSearchMaxChunks', 'DefaultChunkSize'],
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
    };
  } catch (err) {
    logger?.warn?.('[semanticSearch] could not read scan-budget settings; using defaults', err);
    return {
      maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
      maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
      // No configured target reached us, so the chunker's own default is the honest basis.
      maxChunkChars: deriveServeCharBudget(undefined).maxChunkChars,
    };
  }
}

/**
 * Turn the configured chunk token target into the serve character budget, warning when the safety
 * ceiling leaves the cap below the configured chunk size - the residual case where the two still
 * disagree, and the one an operator has to be told about rather than discover as truncated answers.
 */
function resolveServeBudget(rawChunkSize: string | null | undefined, logger?: Logger): number {
  // Same parse-and-warn contract as the scan budgets: unset is normal and silent, set-but-unusable
  // warns and falls back to the chunker's own default - which is what the chunker does with it too.
  const target = positiveIntOr(rawChunkSize, DEFAULT_PASSAGE_TOKEN_TARGET, 'DefaultChunkSize', logger);
  const budget = deriveServeCharBudget(target);
  if (budget.ceilingBound) {
    logger?.warn?.(
      `[semanticSearch] chunk target ${budget.chunkTokenTarget} tokens exceeds the per-passage serve ceiling; ` +
        `serving ${budget.maxChunkChars} chars per chunk, so large chunks will be clipped`
    );
  }
  return budget.maxChunkChars;
}

/** An unset setting is normal and silent; a set-but-unusable one is a misconfiguration worth saying. */
function positiveIntOr(raw: string | null | undefined, fallback: number, label: string, logger?: Logger): number {
  if (raw === null || raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger?.warn?.(`[semanticSearch] ignoring unusable ${label} setting ${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return Math.floor(parsed);
}
