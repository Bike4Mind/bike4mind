import { FabFile, Quest, Session, questRepository, sessionRepository } from '@bike4mind/database';
import { getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import {
  MAX_PATHS_PER_BATCH,
  createCdnInvalidationBatch,
  generatedCdnPath,
} from '@bike4mind/server-utils/services/cdn/invalidateRouterCdn';
import { enqueueGeneratedMediaPurge } from '@server/sessions/generatedMediaPurgeQueue';
import type { MinimalLogger } from '@bike4mind/server-utils/services/publish/minimalLogger';

export type PurgeRequestLogger = MinimalLogger & { error: (msg: string) => void };

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

// Storage deletes in flight at once; this runs inside the delete request, so it stays bounded.
const DELETE_CONCURRENCY = 16;

// Notebooks whose quests are read per lookup, and media keys checked for retention per query set.
export const SESSION_PAGE = 50;
export const KEY_CHUNK = 500;

// Stop starting lookups and deletes after this (ms) so the CDN flush still runs before the request
// times out (60s); what is left goes to the purge queue.
export const PURGE_BUDGET_MS = 20_000;

// Deletes per run, so its CDN flush is one exact-path request; the rest goes to the purge queue.
// Half a request so the purge worker at its concurrency cap (infra/queues.ts) holds at most a third of
// the distribution's in-flight path quota, which publish takedowns share.
export const MAX_DELETES_PER_RUN = MAX_PATHS_PER_BATCH / 2;

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// Only the bare `<uuid>.<ext>` keys the generation tools mint are ever purged. Wider than
// GENERATED_CONTENT_KEY_RE (@bike4mind/common) only in admitting digits in the extension (.mp4).
export const GENERATED_MEDIA_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$/i;
export const isGeneratedContentKey = (key: unknown): key is string =>
  typeof key === 'string' && GENERATED_MEDIA_KEY_RE.test(key);

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

// Keys another live message in a live notebook, or a live file, references.
export async function findLiveRetainedKeys(keys: string[]): Promise<Set<string>> {
  const sessionsByKey = await questRepository.findLiveSessionIdsByMediaKeys(keys);
  const sessionIds = new Set([...sessionsByKey.values()].flat());
  const liveIds = new Set(
    sessionIds.size > 0 ? (await sessionRepository.findAllByIds([...sessionIds])).map(s => String(s._id)) : []
  );
  const retained = await findFileRetainedKeys(keys);
  for (const [key, ids] of sessionsByKey) if (ids.some(id => liveIds.has(id))) retained.add(key);
  return retained;
}

/**
 * The keys that are provably `ownerIds`' own: the earliest-created message holding the key is in a
 * notebook one of them owns. Import, fork and clone only copy keys into newer messages, so a key copied
 * in from someone else's notebook never qualifies.
 */
export async function findOwnedKeys(keys: string[], ownerIds: Set<string>): Promise<Set<string>> {
  const owned = new Set<string>();
  if (keys.length === 0 || ownerIds.size === 0) return owned;
  const originByKey = await questRepository.findOriginSessionIdsByMediaKeys(keys);
  const originIds = [...new Set(originByKey.values())].filter(id => OBJECT_ID_RE.test(id));
  if (originIds.length === 0) return owned;
  const sessions = await Session.find({ _id: { $in: originIds } }, { userId: 1 })
    .setOptions({ includeDeleted: true })
    .lean();
  const ownerBySession = new Map(sessions.map(s => [String(s._id), String(s.userId)]));
  for (const [key, id] of originByKey) if (ownerIds.has(ownerBySession.get(id) ?? '')) owned.add(key);
  return owned;
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

// Doomed keys of one page of notebooks (unreferenced and owned by the page's notebook owners), skipping
// keys already resolved this run; null when the deadline passed before every chunk was checked.
async function resolvePageDoomedKeys(
  page: string[],
  seen: Set<string>,
  { deadline, deletedSessionIds, owners }: { deadline: number; deletedSessionIds: Set<string>; owners: Set<string> }
): Promise<string[] | null> {
  const pageSessions = await Session.find({ _id: { $in: page.filter(id => OBJECT_ID_RE.test(id)) } }, { userId: 1 })
    .setOptions({ includeDeleted: true })
    .lean();
  const pageOwners = new Set(pageSessions.map(s => String(s.userId)).filter(Boolean));
  const quests = await Quest.find({ sessionId: { $in: page } }, { images: 1, videos: 1 })
    .setOptions({ includeDeleted: true })
    .lean();
  const keys = [...new Set(quests.flatMap(q => [...(q.images ?? []), ...(q.videos ?? [])]))].filter(
    key => isGeneratedContentKey(key) && !seen.has(key)
  );
  const doomed: string[] = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    if (Date.now() >= deadline) return null;
    const chunk = keys.slice(i, i + KEY_CHUNK);
    const retained = await findRetainedKeys(chunk, deletedSessionIds);
    const owned = await findOwnedKeys(
      chunk.filter(key => !retained.has(key)),
      pageOwners
    );
    doomed.push(...owned);
  }
  for (const key of keys) seen.add(key);
  for (const owner of pageOwners) owners.add(owner);
  return doomed;
}

// Direct keys still unreferenced and owned by `ownerIds`, re-checked since they were resolved; `unchecked`
// are the keys the deadline cut off.
async function resolveDirectDoomedKeys(
  keys: string[],
  ownerIds: Set<string>,
  deadline: number
): Promise<{ doomed: string[]; unchecked: string[] }> {
  const doomed: string[] = [];
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    if (Date.now() >= deadline) return { doomed, unchecked: keys.slice(i) };
    const chunk = keys.slice(i, i + KEY_CHUNK);
    const retained = await findLiveRetainedKeys(chunk);
    doomed.push(
      ...(await findOwnedKeys(
        chunk.filter(key => !retained.has(key)),
        ownerIds
      ))
    );
  }
  return { doomed, unchecked: [] };
}

export interface GeneratedMediaPurgeLeftovers {
  /** Notebooks not (fully) looked up; the whole page is forwarded, since a re-delete is idempotent. */
  leftoverSessionIds: string[];
  /** Keys not deleted (a failed delete, the deadline or the per-run delete cap); re-checked when retried. */
  leftoverKeys: string[];
  /** Users whose ownership qualified the leftover keys. */
  ownerIds: string[];
}

/**
 * Delete generated media no live notebook or file references and invalidate its CDN paths, stopping
 * at `deadline` (epoch ms) or after MAX_DELETES_PER_RUN deletes and returning what it did not reach.
 * Only keys of the generated-content shape that findOwnedKeys proves are the owners' are deleted.
 * `sessionIds` are deleted notebooks to look up, in pages of SESSION_PAGE, owned by their notebooks'
 * owners; `keys` are re-checked against live references and against `ownerIds`.
 * `deletedSessionIds` are notebooks whose references do not retain a key. A failed page lookup is
 * logged and the page forwarded; a missing storage binding throws before any delete. A failed storage
 * delete is logged and its key returned as a leftover; CDN failures are logged, not returned.
 */
export async function runGeneratedMediaPurge(
  input: { sessionIds?: string[]; keys?: string[]; ownerIds?: string[] },
  { deadline, deletedSessionIds, logger }: { deadline: number; deletedSessionIds: Set<string>; logger: MinimalLogger }
): Promise<GeneratedMediaPurgeLeftovers> {
  const sessionIds = input.sessionIds ?? [];
  const leftoverSessionIds: string[] = [];
  const leftoverKeys: string[] = [];
  const owners = new Set((input.ownerIds ?? []).filter(Boolean));
  const seen = new Set<string>();
  let deletesLeft = MAX_DELETES_PER_RUN;
  let failedDeletes = 0;
  const batch = createCdnInvalidationBatch('notebook-media', logger);
  let storage: ReturnType<typeof getGeneratedImageStorage> | undefined;

  // Returns the keys not deleted: those whose delete failed and those no delete was started for.
  const deleteKeys = async (keys: string[]): Promise<string[]> => {
    if (keys.length === 0) return [];
    storage ??= getGeneratedImageStorage();
    const target = storage;
    const limit = Math.min(keys.length, deletesLeft);
    const deleted = new Set<string>();
    let next = 0;
    const worker = async () => {
      while (next < limit && Date.now() < deadline) {
        const key = keys[next++];
        try {
          // A plain delete, not deletePermanently: the bucket is versioned, so ops keep a recovery window.
          await target.delete(key);
          deleted.add(key);
          batch.add(generatedCdnPath(key));
        } catch (err) {
          failedDeletes++;
          logger.warn(`[NOTEBOOK_MEDIA] Could not purge generated media ${key}: ${errorMessage(err)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(DELETE_CONCURRENCY, limit) }, worker));
    deletesLeft -= next;
    return keys.filter(key => !deleted.has(key));
  };

  try {
    const directKeys = [...new Set(input.keys ?? [])].filter(isGeneratedContentKey);
    for (const key of directKeys) seen.add(key);
    let direct: Awaited<ReturnType<typeof resolveDirectDoomedKeys>>;
    try {
      direct = await resolveDirectDoomedKeys(directKeys, owners, deadline);
    } catch (err) {
      logger.warn(`[NOTEBOOK_MEDIA] Could not resolve generated media keys: ${errorMessage(err)}`);
      direct = { doomed: [], unchecked: directKeys };
    }
    leftoverKeys.push(...direct.unchecked, ...(await deleteKeys(direct.doomed)));

    for (let p = 0; p < sessionIds.length; p += SESSION_PAGE) {
      const page = sessionIds.slice(p, p + SESSION_PAGE);
      let doomed: string[] | null = null;
      if (Date.now() < deadline && deletesLeft > 0) {
        try {
          doomed = await resolvePageDoomedKeys(page, seen, { deadline, deletedSessionIds, owners });
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
  if (leftoverKeys.length > 0 || leftoverSessionIds.length > 0) {
    const reasons = [
      ...(Date.now() >= deadline ? ['time budget spent'] : []),
      ...(failedDeletes > 0 ? [`${failedDeletes} storage deletes failed`] : []),
      ...(deletesLeft <= 0 ? ['per-run delete cap reached'] : []),
    ];
    const reason = reasons.length > 0 ? reasons.join(', ') : 'lookups failed';
    logger.warn(
      `[NOTEBOOK_MEDIA] ${reason}; left ${leftoverKeys.length} generated media keys and ${leftoverSessionIds.length} notebooks unpurged`
    );
  }
  return { leftoverSessionIds, leftoverKeys, ownerIds: [...owners] };
}

/**
 * After notebooks are deleted, remove the generated images and videos only they referenced and
 * invalidate their `/generated/<key>` CDN paths. Call only once the deletes have committed.
 *
 * Only keys the deleted notebooks' owners provably produced are purged (findOwnedKeys). A key is kept
 * while a LIVE notebook (forks, clones and snips copy keys verbatim) or a LIVE file
 * (its `sourceMetadata.generatedCopyKey`) still references it. Unlike purgeAccountContent, dead
 * references do not retain: nothing restores a soft-deleted notebook and only account erasure
 * hard-purges one, so a deleted fork would otherwise pin the bytes until then. What the request
 * budget does not reach goes to the purge queue. Never throws; failures are logged per key.
 */
export async function purgeDeletedNotebookMedia(
  sessionIds: string[],
  { logger }: { logger: PurgeRequestLogger }
): Promise<void> {
  if (sessionIds.length === 0) return;
  try {
    const leftovers = await runGeneratedMediaPurge(
      { sessionIds },
      { deadline: Date.now() + PURGE_BUDGET_MS, deletedSessionIds: new Set(sessionIds), logger }
    );
    const sent = await enqueueGeneratedMediaPurge(
      { sessionIds: leftovers.leftoverSessionIds, keys: leftovers.leftoverKeys, ownerIds: leftovers.ownerIds },
      logger
    );
    // A request cannot retry, so a failed hand-off leaves this media in storage until someone acts.
    if (!sent) {
      logger.error(
        `[NOTEBOOK_MEDIA] Generated media purge hand-off failed in part: up to ${leftovers.leftoverKeys.length} keys and ${leftovers.leftoverSessionIds.length} notebooks left in storage`
      );
    }
  } catch (err) {
    logger.error(`[NOTEBOOK_MEDIA] Generated media storage unavailable: ${errorMessage(err)}`);
  }
}
