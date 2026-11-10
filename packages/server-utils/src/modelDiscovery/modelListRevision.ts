import { randomUUID } from 'node:crypto';
import { MODEL_LIST_REVISION_CACHE_KEY, settingsMap } from '@bike4mind/common';
import { AdminSettings, cacheRepository } from '@bike4mind/database';

/**
 * The shared model-list revision: an opaque stamp rewritten whenever a catalog or price write changes
 * what GET /api/models returns. Each cache between the catalog and a picker checks it:
 * - the per-caller `model-list:*` entries (apps/client/server/utils/callerModelList.ts) are stamped
 *   with it and read in the same query as it;
 * - getAvailableModels' per-process list (b4m-core/llm-adapters) rebuilds when it moves, for chat
 *   callers too, through the provider wired in packages/database/src/priceCatalogBootstrap.ts;
 * - open tabs receive the setting row through their adminsettings subscription and refetch
 *   ['llm', 'models'] (apps/client/app/hooks/data/modelListRevision.ts).
 */

export const MODEL_LIST_REVISION_SETTING = settingsMap.modelListRevision.key;

// The Cache schema requires an expiry. Servers read this row and tabs compare against the setting row,
// which never expires, so the row has to outlive any gap between bumps or the two disagree.
const REVISION_EXPIRES_AT = new Date(Date.UTC(9999, 11, 31));

/**
 * Mark every cached model list stale. Call after the catalog or price write has landed.
 *
 * The cache row goes first: the setting write is what wakes open tabs, and their refetch must find
 * the servers already on the new revision.
 */
export async function bumpModelListRevision(): Promise<string> {
  const revision = randomUUID();
  await cacheRepository.createOrUpdate({
    key: MODEL_LIST_REVISION_CACHE_KEY,
    result: { revision },
    expiresAt: REVISION_EXPIRES_AT,
  });
  await AdminSettings.findOneAndUpdate(
    { settingName: MODEL_LIST_REVISION_SETTING },
    { $set: { settingValue: revision } },
    { upsert: true }
  );
  return revision;
}
