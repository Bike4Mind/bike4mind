import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  IAdminSettingsRepository,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import type { SemanticSearchBudgets } from './semanticDataLakeSearch';

/**
 * Read the operator-configured scan budgets for data-lake semantic search.
 *
 * Shared by every entrypoint (the search route, the chat KB tool, forced retrieval) so one
 * surface cannot end up scanning further than another. Uses the CACHED settings accessor, so
 * this costs no round-trip on a warm cache.
 *
 * Never throws: a settings outage falls back to the coded defaults and warns. The warn matters
 * because the symptom of a bad value would otherwise be "retrieval quietly covers less than the
 * admin configured", which is indistinguishable from a small corpus.
 */
export async function resolveSearchBudgets(
  db: { adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'> },
  logger?: Logger
): Promise<SemanticSearchBudgets> {
  try {
    const values = await getSettingsByNames(['dataLakeSearchMaxFiles', 'dataLakeSearchMaxChunks'], db, { logger });
    return {
      maxFiles: positiveIntOr(values.dataLakeSearchMaxFiles, DATA_LAKE_SEARCH_MAX_FILES_DEFAULT, 'maxFiles', logger),
      maxChunks: positiveIntOr(
        values.dataLakeSearchMaxChunks,
        DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
        'maxChunks',
        logger
      ),
    };
  } catch (err) {
    logger?.warn?.('[semanticSearch] could not read scan-budget settings; using defaults', err);
    return { maxFiles: DATA_LAKE_SEARCH_MAX_FILES_DEFAULT, maxChunks: DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT };
  }
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
