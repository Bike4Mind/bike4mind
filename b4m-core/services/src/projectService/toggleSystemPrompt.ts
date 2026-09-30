import { IFabFileRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
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

  // Update-level, not read-level: toggling a prompt mutates the project. 404 like the other doors
  // in this service, so a caller cannot tell whether a project they cannot update exists.
  const project = await db.projects.shareable.findUpdateAccessById(user, projectId);
  if (!project) throw new NotFoundError('Project not found');

  const promptIndex = project.systemPrompts.findIndex(prompt => prompt.fileId === fileId);
  if (promptIndex === -1) {
    throw new Error('System prompt not found');
  }

  project.systemPrompts[promptIndex].enabled = !project.systemPrompts[promptIndex].enabled;
  project.updatedAt = new Date();

  const written = await db.projects.updateWithUpdateAccess(user, {
    id: project.id,
    systemPrompts: project.systemPrompts,
    updatedAt: project.updatedAt,
  });
  if (!written) throw new NotFoundError('Project not found');

  return project;
};
