import {
  DATA_LAKE_SEARCH_MAX_CHUNKS_DEFAULT,
  DATA_LAKE_SEARCH_MAX_FILES_DEFAULT,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  SettingScope,
} from '@bike4mind/common';
import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import type { SemanticSearchBudgets } from './semanticDataLakeSearch';
import { resolveScopedSettingValues } from '../settings/resolveScopedSetting';

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
 *
 * Scope (epic #1658 lane 0 / #1660): callers that know the org/owner/lake a search runs for may pass
 * a `scope` (and the `scopedSettings` overlay repo) to let a narrower rung tighten the budget below
 * the platform ceiling. Omitting both - every caller today - takes the byte-identical platform path
 * below, so this change is additive. The org/lake rungs #1661 layers on ride this same seam.
 */
export async function resolveSearchBudgets(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
    scopedSettings?: Pick<IScopedSettingsRepository, 'findOverrides'>;
  },
  logger?: Logger,
  scope?: SettingScope
): Promise<SemanticSearchBudgets> {
  // Scoped path: only when a caller both supplies rungs and wires the overlay store. The resolver
  // falls back to the platform value per key, so an un-overridden budget matches the platform path.
  if (scope && db.scopedSettings && scopeHasRung(scope)) {
    try {
      const values = await resolveScopedSettingValues(
        ['dataLakeSearchMaxFiles', 'dataLakeSearchMaxChunks'],
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
      };
    } catch (err) {
      logger?.warn?.('[semanticSearch] scoped budget resolution failed; falling back to platform', err);
      // fall through to the platform path
    }
  }

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

function scopeHasRung(scope: SettingScope): boolean {
  return !!(scope.organizationId || scope.owner?.id || scope.lakeId);
}

/** An unset setting is normal and silent; a set-but-unusable one is a misconfiguration worth saying. */
function positiveIntOr(
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
