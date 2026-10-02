import type { FabFileNotice } from '@bike4mind/utils';
import type { IFabFileRepository, ISessionRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

export interface ScrubMissingKnowledgeIdsAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'findExistingIdsByIds'>;
    sessions: Pick<ISessionRepository, 'pullKnowledgeIds'>;
  };
  logger?: Logger;
}

/**
 * Detach from a notebook the pinned knowledge ids whose FabFile row is GONE, so a deleted document
 * stops re-attaching, re-failing and re-costing a turn on every subsequent prompt.
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
 *   2. Of those, only ids `findExistingIdsByIds` confirms are absent are removed. `unresolved` alone
 *      cannot distinguish a deleted row from one the caller lost access to - a revoked share, a
 *      lapsed lake grant, or a transient lake-access lookup failure all drop an id while the document
 *      is intact. `filterAccessibleKnowledgeIds` keeps unresolved ids for exactly that reason, and
 *      detaching on an outage would be unrecoverable. This asks the narrower question - does the row
 *      exist for anyone - with no permission context involved.
 *
 * `pullKnowledgeIds` ($pull), never a read-modify-write: a turn runs concurrently with whatever else
 * the owner is doing, and rewriting the whole array would clobber a file attached in that window.
 *
 * That primitive is FLEET-WIDE - it pulls the id from every session holding it, not just this one -
 * and that is deliberate. Gate 2 established the row does not exist for anyone, so no notebook can
 * hold a valid reference to it, and the same primitive is what the purge paths already use for
 * exactly this reason (purgeDataLakeConnectionFiles). A session-scoped variant would leave every
 * OTHER notebook pointing at the same dead id, to be repaired only if and when its owner happens to
 * send a prompt. The cost is bounded: the write only matches sessions that hold a confirmed-dead id.
 *
 * Best-effort by contract. Returns the ids removed (empty when there was nothing to do) and never
 * throws - a failure to tidy must not take down the turn that noticed it.
 */
export const scrubMissingKnowledgeIds = async (
  sessionKnowledgeIds: string[],
  notices: FabFileNotice[],
  adapters: ScrubMissingKnowledgeIdsAdapters
): Promise<string[]> => {
  const logger = adapters.logger ?? Logger.globalInstance;

  try {
    if (sessionKnowledgeIds.length === 0) return [];

    const pinned = new Set(sessionKnowledgeIds);
    // Gate 1: the only band that claims the id resolved to nothing.
    const candidates = Array.from(
      new Set(notices.filter(notice => notice.band === 'unresolved').map(notice => notice.fabFileId))
    ).filter(id => pinned.has(id));
    if (candidates.length === 0) return [];

    // Gate 2: confirm the row is really gone before detaching anything.
    const existing = new Set(await adapters.db.fabFiles.findExistingIdsByIds(candidates));
    const missing = candidates.filter(id => !existing.has(id));
    if (missing.length === 0) {
      logger.info('sessionService.scrubMissingKnowledgeIds: every unresolved id still has a row; keeping all', {
        unresolved: candidates,
      });
      return [];
    }

    await adapters.db.sessions.pullKnowledgeIds(missing);
    logger.info('sessionService.scrubMissingKnowledgeIds: detached knowledge ids whose file no longer exists', {
      removed: missing,
    });
    return missing;
  } catch (error) {
    logger.warn('sessionService.scrubMissingKnowledgeIds: scrub failed; leaving the session untouched', { error });
    return [];
  }
};
