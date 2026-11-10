import { FabFile, Quest, questRepository } from '@bike4mind/database';
import { sessionRepository } from '@bike4mind/database/auth';
import { getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { createCdnInvalidationBatch, generatedCdnPath } from '@server/services/cdn/invalidateRouterCdn';
import type { MinimalLogger } from '@server/services/publish/minimalLogger';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * After notebooks are deleted, remove the generated images and videos only they referenced and
 * invalidate their `/generated/<key>` CDN paths. Call only once the deletes have committed.
 *
 * A key is kept while a LIVE notebook (forks, clones and snips copy keys verbatim) or a LIVE file
 * (its `sourceMetadata.generatedCopyKey`) still references it. Unlike purgeAccountContent, dead
 * references do not retain: nothing restores or hard-purges a soft-deleted notebook, so a deleted
 * fork would otherwise pin the bytes forever. Never throws; failures are logged per key.
 */
export async function purgeDeletedNotebookMedia(
  sessionIds: string[],
  { logger }: { logger: MinimalLogger }
): Promise<void> {
  if (sessionIds.length === 0) return;
  const deleted = new Set(sessionIds);
  let keys: string[];
  try {
    const quests = await Quest.find({ sessionId: { $in: sessionIds } }, { images: 1, videos: 1 })
      .setOptions({ includeDeleted: true })
      .lean();
    keys = [...new Set(quests.flatMap(q => [...(q.images ?? []), ...(q.videos ?? [])]))].filter(Boolean);
  } catch (err) {
    logger.warn(`[NOTEBOOK_MEDIA] Could not list generated media for deleted notebooks: ${errorMessage(err)}`);
    return;
  }
  if (keys.length === 0) return;

  let storage: ReturnType<typeof getGeneratedImageStorage>;
  try {
    storage = getGeneratedImageStorage();
  } catch (err) {
    logger.warn(`[NOTEBOOK_MEDIA] Generated media storage unavailable: ${errorMessage(err)}`);
    return;
  }
  const batch = createCdnInvalidationBatch('notebook-media', logger);
  for (const key of keys) {
    try {
      const otherSessionIds = (await questRepository.findSessionIdsByMedia(key)).filter(id => !deleted.has(id));
      if (otherSessionIds.length > 0 && (await sessionRepository.findAllByIds(otherSessionIds)).length > 0) continue;
      if (await FabFile.exists({ 'sourceMetadata.generatedCopyKey': key })) continue;
      // A plain delete, not deletePermanently: the bucket is versioned, so ops keep a recovery window.
      await storage.delete(key);
      batch.add(generatedCdnPath(key));
    } catch (err) {
      logger.warn(`[NOTEBOOK_MEDIA] Could not purge generated media ${key}: ${errorMessage(err)}`);
    }
  }
  await batch.flush();
}
