import { questRepository, sessionRepository } from '@bike4mind/database';
import type { MinimalLogger } from '@server/services/publish/minimalLogger';
import { enqueueGeneratedMediaPurge } from '@server/sessions/generatedMediaPurgeQueue';
import {
  KEY_CHUNK,
  PURGE_BUDGET_MS,
  findFileRetainedKeys,
  runGeneratedMediaPurge,
} from '@server/sessions/purgeDeletedNotebookMedia';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Keys another live message in a live notebook (the same one, a fork, a clone) or a live file references.
async function findRetainedKeys(keys: string[], deletedQuestId: string): Promise<Set<string>> {
  const sessionsByKey = await questRepository.findLiveSessionIdsByMediaKeys(keys, { excludeQuestId: deletedQuestId });
  const sessionIds = new Set([...sessionsByKey.values()].flat());
  const liveIds = new Set(
    sessionIds.size > 0 ? (await sessionRepository.findAllByIds([...sessionIds])).map(s => String(s._id)) : []
  );
  const retained = await findFileRetainedKeys(keys);
  for (const [key, ids] of sessionsByKey) if (ids.some(id => liveIds.has(id))) retained.add(key);
  return retained;
}

/**
 * After one message is deleted, remove the generated images and videos no other live message or live
 * file references and invalidate their `/generated/<key>` CDN paths. Call only once the delete has
 * committed. Retention is per message, not per notebook: the notebook itself is still live. What the
 * request budget does not reach goes to the purge queue. Never throws; failures are logged.
 */
export async function purgeDeletedMessageMedia(
  message: { id: string; images?: string[] | null; videos?: string[] | null },
  { logger }: { logger: MinimalLogger }
): Promise<void> {
  const keys = [...new Set([...(message.images ?? []), ...(message.videos ?? [])])].filter(Boolean);
  if (keys.length === 0) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      const retained = await findRetainedKeys(chunk, message.id);
      doomed.push(...chunk.filter(key => !retained.has(key)));
    }
    if (doomed.length === 0) return;
    const { leftoverKeys } = await runGeneratedMediaPurge(
      { keys: doomed },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(), logger }
    );
    await enqueueGeneratedMediaPurge({ keys: leftoverKeys }, logger);
  } catch (err) {
    logger.warn(`[MESSAGE_MEDIA] Could not purge generated media of a deleted message: ${errorMessage(err)}`);
  }
}
