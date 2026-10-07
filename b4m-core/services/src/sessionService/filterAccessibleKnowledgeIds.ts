import { Logger } from '@bike4mind/observability';
import type { AttachmentLakeAccess, IFabFileRepository, IUserDocument } from '@bike4mind/common';

export interface FilterAccessibleKnowledgeIdsAdapters {
  db: { fabFiles: Pick<IFabFileRepository, 'findAccessibleInIds'> };
  /** Without it only owner/share/global-read files pass, so a lake-only file is refused. */
  resolveAttachmentLakeAccess?: () => Promise<AttachmentLakeAccess>;
  logger?: Logger;
}

/**
 * The subset of caller-supplied knowledge ids the caller may read, in input order. `session.knowledgeIds`
 * is a client-sent `z.array(z.string())`, and anything stored there is later read back as file content
 * (notebook export, retrieval), so a foreign id must not be persisted. Dropped, not rejected - the same
 * treatment as usableSessionIds. Pass only ids the write ADDS: re-checking stored ones would let a
 * rename drop a file whose share was since revoked, which is export's job to hide, not this write's.
 */
export const filterAccessibleKnowledgeIds = async (
  user: IUserDocument,
  ids: string[],
  adapters: FilterAccessibleKnowledgeIdsAdapters
): Promise<string[]> => {
  if (ids.length === 0) return ids;
  const logger = adapters.logger ?? Logger.globalInstance;

  const lakeAccess = adapters.resolveAttachmentLakeAccess
    ? await adapters.resolveAttachmentLakeAccess().catch(error => {
        logger.warn('filterAccessibleKnowledgeIds: lake access resolution failed', { error });
        return { resolutionFailed: true } as AttachmentLakeAccess;
      })
    : undefined;

  const files = await adapters.db.fabFiles.findAccessibleInIds(
    ids,
    { userId: user.id, userGroups: user.groups ?? undefined },
    lakeAccess
  );
  const accessible = new Set(files.map(f => f.id));
  const unresolved = ids.filter(id => !accessible.has(id));
  if (unresolved.length === 0) return ids;

  // An outage cannot prove an id foreign, and dropping it would silently detach a lake file the
  // caller just attached. Kept; readers of knowledgeIds (export, listBySession) re-check access
  // and omit it if it is foreign.
  if (lakeAccess?.resolutionFailed) {
    logger.warn('filterAccessibleKnowledgeIds: keeping unresolved ids, lake access unavailable', {
      userId: user.id,
      unresolved,
    });
    return ids;
  }

  logger.warn('filterAccessibleKnowledgeIds: dropping knowledge ids not accessible to the caller', {
    userId: user.id,
    refused: unresolved,
  });
  const refused = new Set(unresolved);
  return ids.filter(id => !refused.has(id));
};
