import type { IFabFileDocument, IFabFileRepository, IProjectDocument, IProjectRepository } from '@bike4mind/common';
import { createGrantLossCleanup, requireGrantorUsers } from '../sharingService/grantLoss';
import type { GrantorUsers, SharedItem } from '../sharingService/projectGrantor';
import { canonicalId } from '../utils/objectIds';

export type RevokeProjectFileGrantsAdapters = {
  db: {
    fabFiles: IFabFileRepository;
    projects?: IProjectRepository;
    users?: Partial<GrantorUsers>;
  };
  onAccessRemoved?: (userIds: string[]) => void;
};

/** Removes only this project's rows, including tombstones, then follows their dependent grants. */
export const revokeProjectFileGrants = async (
  projectId: string,
  params: { files: IFabFileDocument[]; softDeletedIds?: string[]; project?: IProjectDocument },
  adapters: RevokeProjectFileGrantsAdapters
) => {
  const { db } = adapters;
  const files = [
    ...params.files,
    ...(params.softDeletedIds?.length
      ? await db.fabFiles.findAllByIds(params.softDeletedIds, { includeDeleted: true })
      : []),
  ];
  const changing = files.filter(file =>
    file.users.some(row => !!row.projectId && canonicalId(row.projectId) === canonicalId(projectId))
  );
  if (changing.length === 0) return;
  if (!db.projects) throw new Error('Project grant cleanup requires the project repository');
  const users = requireGrantorUsers(db.users);
  const cleanup = createGrantLossCleanup({
    db: { fabFiles: db.fabFiles, projects: db.projects, users },
    onAccessRemoved: adapters.onAccessRemoved,
  });
  if (params.project) {
    cleanup.trackProject(
      {
        ...params.project,
        fileIds: [...params.project.fileIds],
        sessionIds: [...(params.project.sessionIds ?? [])],
        systemPrompts: [...(params.project.systemPrompts ?? [])],
      },
      false
    );
  }
  for (const file of changing) {
    cleanup.removeRows(
      cleanup.track('files', file as SharedItem),
      row => !!row.projectId && canonicalId(row.projectId) === canonicalId(projectId)
    );
  }
  await cleanup.drain();
  await cleanup.flush();
};
