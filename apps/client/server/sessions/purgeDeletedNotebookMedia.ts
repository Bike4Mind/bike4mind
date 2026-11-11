import { FabFile, Quest, questRepository, sessionRepository } from '@bike4mind/database';
import { getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { createCdnInvalidationBatch, generatedCdnPath } from '@bike4mind/server-utils/services/cdn/invalidateRouterCdn';
import type { MinimalLogger } from '@bike4mind/server-utils/services/publish/minimalLogger';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Storage deletes in flight at once; this runs inside the delete request, so it stays bounded.
const DELETE_CONCURRENCY = 16;

// Stop starting deletes after this (ms) so the CDN flush still runs before the request times out
// (60s); undeleted keys keep their bytes, which is consistent with what the CDN still serves.
export const PURGE_BUDGET_MS = 20_000;

// Keys some LIVE notebook other than the deleted ones, or some LIVE file, still references.
async function findRetainedKeys(keys: string[], deleted: Set<string>): Promise<Set<string>> {
  const sessionsByKey = await questRepository.findSessionIdsByMediaKeys(keys);
  const otherIds = new Set<string>();
  for (const ids of sessionsByKey.values()) for (const id of ids) if (!deleted.has(id)) otherIds.add(id);
  const liveIds = new Set(
    otherIds.size > 0 ? (await sessionRepository.findAllByIds([...otherIds])).map(s => String(s._id)) : []
  );
  const retained = new Set<string>();
  for (const [key, ids] of sessionsByKey) if (ids.some(id => liveIds.has(id))) retained.add(key);

  const files = await FabFile.find(
    { 'sourceMetadata.generatedCopyKey': { $in: keys } },
    { 'sourceMetadata.generatedCopyKey': 1 }
  ).lean();
  for (const file of files) {
    const key = (file.sourceMetadata as Record<string, unknown> | undefined)?.generatedCopyKey;
    if (typeof key === 'string') retained.add(key);
  }
  return retained;
}

/**
 * After notebooks are deleted, remove the generated images and videos only they referenced and
 * invalidate their `/generated/<key>` CDN paths. Call only once the deletes have committed.
 *
 * A key is kept while a LIVE notebook (forks, clones and snips copy keys verbatim) or a LIVE file
 * (its `sourceMetadata.generatedCopyKey`) still references it. Unlike purgeAccountContent, dead
 * references do not retain: nothing restores a soft-deleted notebook and only account erasure
 * hard-purges one, so a deleted fork would otherwise pin the bytes until then. Never throws;
 * failures are logged per key.
 */
export async function purgeDeletedNotebookMedia(
  sessionIds: string[],
  { logger }: { logger: MinimalLogger }
): Promise<void> {
  if (sessionIds.length === 0) return;
  const deadline = Date.now() + PURGE_BUDGET_MS;
  const deleted = new Set(sessionIds);
  let keys: string[];
  let retained: Set<string>;
  try {
    const quests = await Quest.find({ sessionId: { $in: sessionIds } }, { images: 1, videos: 1 })
      .setOptions({ includeDeleted: true })
      .lean();
    keys = [...new Set(quests.flatMap(q => [...(q.images ?? []), ...(q.videos ?? [])]))].filter(Boolean);
    if (keys.length === 0) return;
    retained = await findRetainedKeys(keys, deleted);
  } catch (err) {
    logger.warn(`[NOTEBOOK_MEDIA] Could not resolve generated media for deleted notebooks: ${errorMessage(err)}`);
    return;
  }
  const doomed = keys.filter(key => !retained.has(key));
  if (doomed.length === 0) return;

  let storage: ReturnType<typeof getGeneratedImageStorage>;
  try {
    storage = getGeneratedImageStorage();
  } catch (err) {
    logger.warn(`[NOTEBOOK_MEDIA] Generated media storage unavailable: ${errorMessage(err)}`);
    return;
  }
  const batch = createCdnInvalidationBatch('notebook-media', logger);
  let next = 0;
  const worker = async () => {
    while (next < doomed.length && Date.now() < deadline) {
      const key = doomed[next++];
      try {
        // A plain delete, not deletePermanently: the bucket is versioned, so ops keep a recovery window.
        await storage.delete(key);
        batch.add(generatedCdnPath(key));
      } catch (err) {
        logger.warn(`[NOTEBOOK_MEDIA] Could not purge generated media ${key}: ${errorMessage(err)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, doomed.length) }, worker));
  if (next < doomed.length) {
    logger.warn(`[NOTEBOOK_MEDIA] Time budget spent; left ${doomed.length - next} generated media keys in place`);
  }
  await batch.flush();
}
