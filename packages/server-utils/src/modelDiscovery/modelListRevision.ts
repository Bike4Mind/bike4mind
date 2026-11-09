import { randomUUID } from 'node:crypto';
import { settingsMap, type ICacheDocument } from '@bike4mind/common';
import { AdminSettings, cacheRepository } from '@bike4mind/database';

/**
 * The shared model-list revision: an opaque stamp rewritten whenever a catalog write changes what
 * GET /api/models returns. Each cache between the catalog and a picker checks it:
 * - the per-caller `model-list:*` entries (apps/client/server/utils/callerModelList.ts) are stamped
 *   with it and read in the same query as it;
 * - getAvailableModels' per-process list (b4m-core/llm-adapters) rebuilds when a caller passes a new one;
 * - open tabs receive the setting row through their adminsettings subscription and refetch
 *   ['llm', 'models'] (apps/client/app/hooks/data/modelListRevision.ts).
 */

/** Outside `model-list:*` on purpose: callerModelList is the only writer of those keys. */
export const MODEL_LIST_REVISION_CACHE_KEY = 'model-list-revision';

export const MODEL_LIST_REVISION_SETTING = settingsMap.modelListRevision.key;

// The stamp only has to outlive the caches it versions (60 s entries, a 5 min process cache).
const REVISION_TTL_MS = 30 * 24 * 60 * 60_000;

export function modelListRevisionOf(doc: Pick<ICacheDocument, 'result'> | null | undefined): string | null {
  const revision = (doc?.result as { revision?: unknown } | undefined)?.revision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

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
    expiresAt: new Date(Date.now() + REVISION_TTL_MS),
  });
  await AdminSettings.findOneAndUpdate(
    { settingName: MODEL_LIST_REVISION_SETTING },
    { $set: { settingValue: revision } },
    { upsert: true }
  );
  return revision;
}
