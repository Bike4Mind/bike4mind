import { FabFile, Quest, questRepository, sessionRepository } from '@bike4mind/database';
import { getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { createCdnInvalidationBatch, generatedCdnPath } from '@server/services/cdn/invalidateRouterCdn';
import { enqueueGeneratedMediaPurge } from '@server/sessions/generatedMediaPurgeQueue';
import type { MinimalLogger } from '@server/services/publish/minimalLogger';

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Storage deletes in flight at once; this runs inside the delete request, so it stays bounded.
const DELETE_CONCURRENCY = 16;

// Notebooks whose quests are read per lookup, and media keys checked for retention per query set.
export const SESSION_PAGE = 50;
export const KEY_CHUNK = 500;

// Stop starting lookups and deletes after this (ms) so the CDN flush still runs before the request
// times out (60s); undeleted keys keep their bytes, which is consistent with what the CDN still serves.
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
  for (const key of await findFileRetainedKeys(keys)) retained.add(key);
  return retained;
}

// Keys some live library file was copied from (its `sourceMetadata.generatedCopyKey`).
export async function findFileRetainedKeys(keys: string[]): Promise<Set<string>> {
  const retained = new Set<string>();
  if (keys.length === 0) return retained;
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

// Doomed keys of one page of notebooks, skipping keys already resolved this run; null when the
// deadline passed before every retention chunk was checked.
async function resolvePageDoomedKeys(
  page: string[],
  seen: Set<string>,
  { deadline, deletedSessionIds }: { deadline: number; deletedSessionIds: Set<string> }
): Promise<string[] | null> {
  const quests = await Quest.find({ sessionId: { $in: page } }, { images: 1, videos: 1 })
    .setOptions({ includeDeleted: true })
    .lean();
  const keys = [...new Set(quests.flatMap(q => [...(q.images ?? []), ...(q.videos ?? [])]))].filter(
    key => key && !seen.has(key)
  );
  const doomed: string[] = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    if (Date.now() >= deadline) return null;
    const chunk = keys.slice(i, i + KEY_CHUNK);
    const retained = await findRetainedKeys(chunk, deletedSessionIds);
    doomed.push(...chunk.filter(key => !retained.has(key)));
  }
  for (const key of keys) seen.add(key);
  return doomed;
}

export interface GeneratedMediaPurgeLeftovers {
  /** Notebooks not (fully) looked up; the whole page is forwarded, since a re-delete is idempotent. */
  leftoverSessionIds: string[];
  /** Keys resolved as unreferenced but not deleted before the deadline. */
  leftoverKeys: string[];
}

/**
 * Delete generated media no live notebook or file references and invalidate its CDN paths, stopping
 * at `deadline` (epoch ms) and returning what it did not reach. `sessionIds` are deleted notebooks to
 * look up, in pages of SESSION_PAGE; `keys` were already resolved as unreferenced and are deleted
 * without a retention check. `deletedSessionIds` are notebooks whose references do not retain a key.
 * A failed page lookup is logged and the page forwarded; a missing storage binding throws before any
 * delete. Per-key storage and CDN failures are logged, not returned.
 */
export async function runGeneratedMediaPurge(
  input: { sessionIds?: string[]; keys?: string[] },
  { deadline, deletedSessionIds, logger }: { deadline: number; deletedSessionIds: Set<string>; logger: MinimalLogger }
): Promise<GeneratedMediaPurgeLeftovers> {
  const sessionIds = input.sessionIds ?? [];
  const leftoverSessionIds: string[] = [];
  const leftoverKeys: string[] = [];
  const seen = new Set<string>();
  const batch = createCdnInvalidationBatch('notebook-media', logger);
  let storage: ReturnType<typeof getGeneratedImageStorage> | undefined;

  // Returns the keys no delete was started for before the deadline.
  const deleteKeys = async (keys: string[]): Promise<string[]> => {
    if (keys.length === 0) return [];
    storage ??= getGeneratedImageStorage();
    const target = storage;
    let next = 0;
    const worker = async () => {
      while (next < keys.length && Date.now() < deadline) {
        const key = keys[next++];
        try {
          // A plain delete, not deletePermanently: the bucket is versioned, so ops keep a recovery window.
          await target.delete(key);
          batch.add(generatedCdnPath(key));
        } catch (err) {
          logger.warn(`[NOTEBOOK_MEDIA] Could not purge generated media ${key}: ${errorMessage(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, keys.length) }, worker));
    return keys.slice(next);
  };

  try {
    const directKeys = [...new Set(input.keys ?? [])].filter(Boolean);
    for (const key of directKeys) seen.add(key);
    leftoverKeys.push(...(await deleteKeys(directKeys)));

    for (let p = 0; p < sessionIds.length; p += SESSION_PAGE) {
      const page = sessionIds.slice(p, p + SESSION_PAGE);
      let doomed: string[] | null = null;
      if (Date.now() < deadline) {
        try {
          doomed = await resolvePageDoomedKeys(page, seen, { deadline, deletedSessionIds });
        } catch (err) {
          logger.warn(`[NOTEBOOK_MEDIA] Could not resolve generated media for deleted notebooks: ${errorMessage(err)}`);
          leftoverSessionIds.push(...page);
          continue;
        }
      }
      if (doomed === null) {
        leftoverSessionIds.push(...sessionIds.slice(p));
        break;
      }
      leftoverKeys.push(...(await deleteKeys(doomed)));
    }
  } finally {
    await batch.flush();
  }
  if (Date.now() >= deadline && (leftoverKeys.length > 0 || leftoverSessionIds.length > 0)) {
    logger.warn(
      `[NOTEBOOK_MEDIA] Time budget spent; left ${leftoverKeys.length} generated media keys and ${leftoverSessionIds.length} notebooks unpurged`
    );
  }
  return { leftoverSessionIds, leftoverKeys };
}

/**
 * After notebooks are deleted, remove the generated images and videos only they referenced and
 * invalidate their `/generated/<key>` CDN paths. Call only once the deletes have committed.
 *
 * A key is kept while a LIVE notebook (forks, clones and snips copy keys verbatim) or a LIVE file
 * (its `sourceMetadata.generatedCopyKey`) still references it. Unlike purgeAccountContent, dead
 * references do not retain: nothing restores a soft-deleted notebook and only account erasure
 * hard-purges one, so a deleted fork would otherwise pin the bytes until then. What the request
 * budget does not reach goes to the purge queue. Never throws; failures are logged per key.
 */
export async function purgeDeletedNotebookMedia(
  sessionIds: string[],
  { logger }: { logger: MinimalLogger }
): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const { leftoverSessionIds, leftoverKeys } = await runGeneratedMediaPurge(
      { sessionIds },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(sessionIds), logger }
    );
    await enqueueGeneratedMediaPurge({ sessionIds: leftoverSessionIds, keys: leftoverKeys }, logger);
  } catch (err) {
    logger.warn(`[NOTEBOOK_MEDIA] Generated media storage unavailable: ${errorMessage(err)}`);
  }
}
