import type { FabFileNotice } from '@bike4mind/utils';
import type { IProjectRepository, IUserRepository } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { classifyUnresolvedFileIds, type UnresolvedFileIdsLookup } from './classifyUnresolvedFileIds';

/**
 * The `user.systemFiles` and project counterparts of scrubMissingKnowledgeIds: drop a reference whose
 * file this turn reported `unresolved` AND whose row is gone or soft-deleted. Same two gates (see
 * classifyUnresolvedFileIds) - a live row the caller cannot read is always kept - and the same
 * best-effort contract: returns the ids removed and never throws.
 */

export interface ScrubStaleSystemFilesAdapters {
  db: { fabFiles: UnresolvedFileIdsLookup; users: Pick<IUserRepository, 'pullSystemFiles'> };
  logger?: Logger;
}

/** Only ever the caller's OWN `systemFiles`; the admin-wide `SystemFiles` setting is not touched here. */
export const scrubStaleSystemFiles = async (
  userId: string,
  systemFileIds: string[],
  notices: FabFileNotice[],
  adapters: ScrubStaleSystemFilesAdapters
): Promise<string[]> => {
  const logger = adapters.logger ?? Logger.globalInstance;
  try {
    if (systemFileIds.length === 0) return [];
    const { gone, softDeleted } = await classifyUnresolvedFileIds(systemFileIds, notices, adapters.db.fabFiles);
    const stale = [...gone, ...softDeleted];
    if (stale.length === 0) return [];
    await adapters.db.users.pullSystemFiles(userId, stale);
    logger.info('sessionService.scrubStaleSystemFiles: removed system files whose file no longer exists', {
      removed: stale,
    });
    return stale;
  } catch (error) {
    logger.warn('sessionService.scrubStaleSystemFiles: scrub failed; leaving system files untouched', { error });
    return [];
  }
};

export interface ScrubStaleProjectFilesAdapters {
  db: { fabFiles: UnresolvedFileIdsLookup; projects: Pick<IProjectRepository, 'pullFileReferences'> };
  logger?: Logger;
}

/**
 * Scoped to the one project the turn read. A project is shared, so which collaborator's turn noticed
 * the file does not matter - gate 2 already established the row is gone or deleted for everyone.
 */
export const scrubStaleProjectFiles = async (
  project: { id: string; fileIds?: string[]; systemPrompts?: { fileId: string }[] },
  notices: FabFileNotice[],
  adapters: ScrubStaleProjectFilesAdapters
): Promise<string[]> => {
  const logger = adapters.logger ?? Logger.globalInstance;
  try {
    const referenced = [...(project.fileIds ?? []), ...(project.systemPrompts ?? []).map(prompt => prompt.fileId)];
    if (referenced.length === 0) return [];
    const { gone, softDeleted } = await classifyUnresolvedFileIds(referenced, notices, adapters.db.fabFiles);
    const stale = [...gone, ...softDeleted];
    if (stale.length === 0) return [];
    await adapters.db.projects.pullFileReferences(stale, project.id);
    logger.info('sessionService.scrubStaleProjectFiles: removed project files whose file no longer exists', {
      projectId: project.id,
      removed: stale,
    });
    return stale;
  } catch (error) {
    logger.warn('sessionService.scrubStaleProjectFiles: scrub failed; leaving the project untouched', { error });
    return [];
  }
};
