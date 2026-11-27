import {
  IFabFileRepository,
  IInviteRepository,
  IProjectRepository,
  IUserRepository,
  secureParameters,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from '@bike4mind/common';
import { z } from 'zod';
import { canonicalId } from '../utils/objectIds';
import { usableObjectIds } from '@bike4mind/db-core';
import { revokeProjectFileGrants } from './revokeProjectFileGrants';

const removeProjectFilesSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type RemoveProjectFilesParameters = z.infer<typeof removeProjectFilesSchema>;

interface RemoveProjectFilesAdapters {
  db: {
    projects: IProjectRepository;
    fabFiles: IFabFileRepository;
    users: IUserRepository;
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
  };
  onAccessRemoved?: (userIds: string[]) => void;
}

export const removeFiles = async (
  userId: string,
  params: RemoveProjectFilesParameters,
  adapters: RemoveProjectFilesAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, removeProjectFilesSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new NotFoundError('Project not found');

  const files = await db.fabFiles.shareable.findAllAccessibleByIds(user, fileIds);

  // BadRequestError, not a bare Error - see addFiles.
  // Asked for by id, not by count, so a duplicate cannot read as a miss. An id that cannot
  // address a row is EXCLUDED rather than rejected: it is what the caller wants gone, the read
  // guards skip it, and rejecting left it in the project permanently, warning on every read.
  // The filter below still removes it. A castable id that did not resolve is still an access
  // failure and still a 400.
  // Compared canonically - hex folded to lowercase, non-hex left exactly as stored. A hex id is
  // accepted in either case and resolves the same row, but `f.id` is always canonical lowercase,
  // so matching raw strings would reject an uppercase id that Mongo resolved perfectly well.
  // Non-hex is NOT folded: two legacy entries differing only in case are different rows.
  const resolvedIds = new Set(files.map(f => canonicalId(String(f.id))));
  const addressable = new Set(usableObjectIds(fileIds, 'projectService.removeFiles').map(canonicalId));
  // The project owner may still clear an id the project holds whose row is gone (deleted, or never
  // there): nothing else can take it out of the list. A live row the owner cannot read stays refused,
  // because removing it here could not revoke the access the project granted on it.
  const unresolved = fileIds.filter(id => addressable.has(canonicalId(id)) && !resolvedIds.has(canonicalId(id)));
  const ownerHeld = new Set(project.userId === userId ? project.fileIds.map(canonicalId) : []);
  const heldUnresolved = unresolved.filter(id => ownerHeld.has(canonicalId(id)));
  const [liveIds, existingIds] =
    heldUnresolved.length > 0
      ? await Promise.all([
          db.fabFiles.findExistingIdsByIds(heldUnresolved),
          db.fabFiles.findExistingIdsIncludingDeletedByIds(heldUnresolved),
        ])
      : [[], []];
  const live = new Set(liveIds.map(canonicalId));
  if (unresolved.some(id => !ownerHeld.has(canonicalId(id)) || live.has(canonicalId(id)))) {
    throw new BadRequestError('Some files are not accessible');
  }
  // A soft-deleted row is hidden from the reads above but keeps its project-tagged grants, which a
  // restore would bring back; only an id with no row at all needs no revoke.
  const softDeletedIds = existingIds.filter(id => !live.has(canonicalId(id)));

  if (project.userId !== userId) {
    const ownedIds = new Set(files.filter(f => f.userId === userId).map(f => canonicalId(String(f.id))));
    if (fileIds.some(id => !ownedIds.has(canonicalId(id)))) {
      throw new ForbiddenError('You are not authorized to remove files from this project');
    }
  }

  // Canonical on both sides here too: a stored id is lowercase, so an uppercase request id
  // would match nothing and the call would answer 200 having removed nothing at all.
  const removing = new Set(fileIds.map(canonicalId));
  const removedIds = project.fileIds.filter(id => removing.has(canonicalId(id)));
  if (removedIds.length === 0) return { project, removedIds };
  project.fileIds = project.fileIds.filter(id => !removing.has(canonicalId(id)));
  project.updatedAt = new Date();

  // A file still attached as a system prompt stays shared with the members, so its grants stay too
  // (removeSystemPrompts makes the mirror check against fileIds).
  const promptIds = new Set((project.systemPrompts ?? []).map(prompt => canonicalId(prompt.fileId)));
  const stillShared = (id: string) => promptIds.has(canonicalId(id));
  await revokeProjectFileGrants(
    project.id,
    {
      project,
      files: files.filter(file => !stillShared(String(file.id))),
      softDeletedIds: softDeletedIds.filter(id => !stillShared(id)),
    },
    adapters
  );

  await db.projects.update({ id: project.id, fileIds: project.fileIds, updatedAt: project.updatedAt });

  // removedIds are the stored ids actually taken out, so callers can skip side effects for a no-op.
  return { project, removedIds };
};
