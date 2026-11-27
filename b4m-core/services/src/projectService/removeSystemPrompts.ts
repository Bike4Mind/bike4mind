import {
  IFabFileRepository,
  IInviteRepository,
  IProjectDocument,
  IProjectRepository,
  IUserDocument,
  IUserRepository,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { canonicalId } from '../utils/objectIds';
import { revokeProjectFileGrants } from './revokeProjectFileGrants';
import type { GrantorUsers } from '../sharingService/projectGrantor';

const removeSystemPromptsSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type RemoveSystemPromptsParameters = z.infer<typeof removeSystemPromptsSchema>;

interface RemoveSystemPromptsAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
    users: Pick<IUserRepository, 'findByIds'> & Partial<GrantorUsers>;
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
  };
  onAccessRemoved?: (userIds: string[]) => void;
}

// Removes the given fileIds from a project's systemPrompts in one pass. Idempotent:
// ids that aren't present are simply skipped (mirrors removeFiles). Revokes the grants the
// project pushed onto each removed file, like removeFiles, unless it is still in fileIds.
export const removeSystemPrompts = async (
  user: IUserDocument,
  params: RemoveSystemPromptsParameters,
  adapters: RemoveSystemPromptsAdapters
) => {
  const { db } = adapters;
  const { projectId, fileIds } = secureParameters(params, removeSystemPromptsSchema);

  // Update-level, not read-level: dropping a system prompt mutates the project, so a read grant
  // must not reach it. Normalized to a plain object because this predicate returns a hydrated
  // document where findAccessibleById did not, and `project` is handed to db.projects.update below.
  const found = await db.projects.shareable.findUpdateAccessById(user, projectId);
  // NotFoundError, not a bare Error: this refusal is routine and user-triggerable - a read-only
  // sharee clicking the button reaches it - and a bare Error is a 500 that pages LiveOps. 404
  // rather than 403 for the same reason every other door in this service answers 404: it does not
  // tell a caller whether a project they cannot reach exists.
  if (!found) throw new NotFoundError('Project not found');

  const project = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IProjectDocument }).toJSON()
      : found
  ) as IProjectDocument;

  const removeSet = new Set(fileIds.map(canonicalId));
  const removedIds = project.systemPrompts
    .map(prompt => prompt.fileId)
    .filter(fileId => removeSet.has(canonicalId(fileId)));
  project.systemPrompts = project.systemPrompts.filter(prompt => !removeSet.has(canonicalId(prompt.fileId)));
  project.updatedAt = new Date();

  // A file still in fileIds stays shared with the members (removeFiles makes the mirror check).
  // Looked up unscoped, as acceptProject does: a revoke only narrows access, and the caller already
  // holds update on the project. An id with no live row may be soft-deleted, so it is revoked with
  // includeDeleted; one with no row at all is a no-op there.
  const attachedFileIds = new Set((project.fileIds ?? []).map(canonicalId));
  const revoking = removedIds.filter(fileId => !attachedFileIds.has(canonicalId(fileId)));
  if (revoking.length > 0) {
    const files = await db.fabFiles.findAllByIds(revoking);
    const live = new Set(files.map(file => canonicalId(String(file.id))));
    const softDeletedIds = revoking.filter(fileId => !live.has(canonicalId(fileId)));
    await revokeProjectFileGrants(project.id, { files, softDeletedIds, project }, adapters);
  }

  await db.projects.update({ id: project.id, systemPrompts: project.systemPrompts, updatedAt: project.updatedAt });
  return project;
};
