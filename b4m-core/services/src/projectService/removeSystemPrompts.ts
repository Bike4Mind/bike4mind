import { IFabFileRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
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

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const removeSet = new Set(fileIds);
  project.systemPrompts = project.systemPrompts.filter(prompt => !removeSet.has(prompt.fileId));
  project.updatedAt = new Date();

  await db.projects.update(project);

  return project;
};
