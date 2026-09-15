import { IFabFileRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const toggleSystemPromptSchema = z.object({
  projectId: z.string(),
  fileId: z.string(),
});

type ToggleSystemPromptParameters = z.infer<typeof toggleSystemPromptSchema>;

interface ToggleSystemPromptAdapters {
  db: {
    fabFiles: IFabFileRepository;
    projects: IProjectRepository;
  };
}

export const toggleSystemPrompt = async (
  user: IUserDocument,
  params: ToggleSystemPromptParameters,
  adapters: ToggleSystemPromptAdapters
) => {
  const { db } = adapters;
  const { projectId, fileId } = secureParameters(params, toggleSystemPromptSchema);

  const project = await db.projects.shareable.findAccessibleById(user, projectId);
  if (!project) throw new Error('Project not found');

  const promptIndex = project.systemPrompts.findIndex(prompt => prompt.fileId === fileId);
  if (promptIndex === -1) {
    throw new Error('System prompt not found');
  }

  project.systemPrompts[promptIndex].enabled = !project.systemPrompts[promptIndex].enabled;
  project.updatedAt = new Date();

  await db.projects.update(project);

  return project;
};
