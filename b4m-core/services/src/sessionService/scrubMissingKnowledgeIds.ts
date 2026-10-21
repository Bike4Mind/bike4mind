import type { FabFileNotice } from '@bike4mind/utils';
import type { ISessionRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { classifyUnresolvedFileIds, type UnresolvedFileIdsLookup } from './classifyUnresolvedFileIds';

export interface ScrubMissingKnowledgeIdsAdapters {
  db: {
    fabFiles: UnresolvedFileIdsLookup;
    sessions: Pick<ISessionRepository, 'pullKnowledgeIds' | 'pullKnowledgeIdsFromSession'>;
  };
  logger?: Logger;
}

/**
 * Detach from a notebook the pinned knowledge ids whose FabFile row is gone or soft-deleted, so a
 * deleted document stops re-attaching, re-failing and re-costing a turn on every subsequent prompt.
 *
 * DOUBLE-GATED, and both gates are load-bearing. The turn's `droppedIds` is far too broad to drive a
 * delete: it is "every requested id that put no content in the prompt", which includes an audio file
 * (never inlineable), an image on a model without vision, an image held by the moderation scan, an
 * image the active provider cannot accept, and a file that merely failed to read this once. Those are
 * live documents the user deliberately attached - detaching them would silently destroy a notebook's
 * contents as a side effect of one ordinary prompt, which is far worse than the stale-pointer problem
 * this exists to fix. So:
 *
 *   1. Only the `unresolved` band is considered. That is the one band meaning "the id resolved to no
 *      document at all" - see fetchAndConvertFabFiles, which emits it when getAccessibleFiles did not
 *      return the id. Every other band describes a file that WAS found.
 *   2. Of those, only ids whose row is absent or soft-deleted are removed (classifyUnresolvedFileIds).
 *      A LIVE row is always kept: `unresolved` alone cannot distinguish a deleted row from one the
 *      caller lost access to - a revoked share, a lapsed lake grant, or a transient lake-access
 *      lookup failure all drop an id while the document is intact.
 *
 * The two removable cases are written at different widths:
 *
 *   - No row at all: FLEET-WIDE `pullKnowledgeIds`. The row does not exist for anyone and cannot be
 *     brought back, so no notebook can hold a reference worth keeping - the same primitive the
 *     data-lake purge paths use for this reason (purgeDataLakeConnectionFiles).
 *   - Soft-deleted: THIS session only (`pullKnowledgeIdsFromSession`), and only when `sessionId` is
 *     given. A lake teardown soft-deletes its members and `restoreDeletedDataLake` can revive them;
 *     a restored file can be re-attached, but a ghost that warns on every prompt cannot be dismissed
 *     by the user, so the notebook that keeps hitting it lets go. Other notebooks are left as they
 *     are until their own turn notices the same thing.
 *
 * Both are `$pull`s, never a read-modify-write: a turn runs concurrently with whatever else the owner
 * is doing, and rewriting the whole array would clobber a file attached in that window.
 *
 * Best-effort by contract. Returns the ids removed from this session (empty when there was nothing to
 * do, or only the writes that landed before a failure) and never throws - a failure to tidy must not take down the turn that noticed it.
 */
export const scrubMissingKnowledgeIds = async (
  sessionKnowledgeIds: string[],
  notices: FabFileNotice[],
  adapters: ScrubMissingKnowledgeIdsAdapters,
  sessionId?: string
): Promise<string[]> => {
  const logger = adapters.logger ?? Logger.globalInstance;
  const removed: string[] = [];

  try {
    if (sessionKnowledgeIds.length === 0) return [];

    const { gone, softDeleted } = await classifyUnresolvedFileIds(sessionKnowledgeIds, notices, adapters.db.fabFiles);
    const detachSoftDeleted = sessionId ? softDeleted : [];
    if (gone.length === 0 && detachSoftDeleted.length === 0) {
      if (softDeleted.length > 0) {
        logger.info('sessionService.scrubMissingKnowledgeIds: soft-deleted ids kept; no session to scope to', {
          softDeleted,
        });
      }
      return [];
    }

    if (gone.length > 0) {
      await adapters.db.sessions.pullKnowledgeIds(gone);
      removed.push(...gone);
    }
    if (sessionId && detachSoftDeleted.length > 0) {
      await adapters.db.sessions.pullKnowledgeIdsFromSession(sessionId, detachSoftDeleted);
      removed.push(...detachSoftDeleted);
    }
    logger.info('sessionService.scrubMissingKnowledgeIds: detached knowledge ids whose file no longer exists', {
      removed,
      gone,
      softDeleted: detachSoftDeleted,
    });
    return removed;
  } catch (error) {
    // Whatever was already pulled stays pulled, so report it - the caller trims its in-memory copy.
    logger.warn('sessionService.scrubMissingKnowledgeIds: scrub failed part-way', { error, removed });
    return removed;
  }
};
