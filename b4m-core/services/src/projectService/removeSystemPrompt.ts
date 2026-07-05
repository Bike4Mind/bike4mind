import { IFabFileRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const removeSystemPromptSchema = z.object({
  projectId: z.string(),
  fileId: z.string(),
});

type RemoveSystemPromptParameters = z.infer<typeof removeSystemPromptSchema>;

interface RemoveSystemPromptAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const removeSystemPrompt = async (
  user: IUserDocument,
  params: RemoveSystemPromptParameters,
  adapters: RemoveSystemPromptAdapters
) => {
  const { db } = adapters;
  const { projectId, fileId } = secureParameters(params, removeSystemPromptSchema);

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const promptIndex = project.systemPrompts.findIndex(prompt => prompt.fileId === fileId);
  if (promptIndex === -1) {
    throw new Error('System prompt not found');
  }

  project.systemPrompts.splice(promptIndex, 1);
  project.updatedAt = new Date();

  await db.projects.update(project);

  return project;
};
