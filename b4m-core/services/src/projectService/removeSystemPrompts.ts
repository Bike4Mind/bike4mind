import { IFabFileRepository, IProjectDocument, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const removeSystemPromptsSchema = z.object({
  projectId: z.string(),
  fileIds: z.array(z.string()),
});

type RemoveSystemPromptsParameters = z.infer<typeof removeSystemPromptsSchema>;

interface RemoveSystemPromptsAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

// Removes the given fileIds from a project's systemPrompts in one pass. Idempotent:
// ids that aren't present are simply skipped (mirrors removeFiles). System prompts do
// not un-share the underlying fabFile, so this only touches project.systemPrompts.
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
  if (!found) throw new Error('Project not found');

  const project = (
    typeof (found as { toJSON?: unknown }).toJSON === 'function'
      ? (found as unknown as { toJSON: () => IProjectDocument }).toJSON()
      : found
  ) as IProjectDocument;

  const removeSet = new Set(fileIds);
  project.systemPrompts = project.systemPrompts.filter(prompt => !removeSet.has(prompt.fileId));
  project.updatedAt = new Date();

  await db.projects.update(project);

  return project;
};
