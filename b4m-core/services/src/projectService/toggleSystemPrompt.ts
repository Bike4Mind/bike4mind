import { IFabFileRepository, IProjectRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const toggleSystemPromptSchema = z.object({
  projectId: z.string(),
  fileId: z.string(),
  // Set this state instead of flipping it, so a retried request cannot undo itself.
  enabled: z.boolean().optional(),
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
  const { projectId, fileId, enabled } = secureParameters(params, toggleSystemPromptSchema);

  // Update-level, not read-level: toggling a prompt mutates the project. 404 like the other doors
  // in this service, so a caller cannot tell whether a project they cannot update exists.
  const project = await db.projects.shareable.findUpdateAccessById(user, projectId);
  if (!project) throw new NotFoundError('Project not found');

  const promptIndex = project.systemPrompts.findIndex(prompt => prompt.fileId === fileId);
  // Not a bare Error: a caller naming a file that is not a prompt is routine, not a 500.
  if (promptIndex === -1) throw new NotFoundError('System prompt not found');

  const next = enabled ?? !project.systemPrompts[promptIndex].enabled;
  if (next === project.systemPrompts[promptIndex].enabled) return project;
  project.systemPrompts[promptIndex].enabled = next;
  project.updatedAt = new Date();

  const written = await db.projects.updateWithUpdateAccess(user, {
    id: project.id,
    systemPrompts: project.systemPrompts,
    updatedAt: project.updatedAt,
  });
  if (!written) throw new NotFoundError('Project not found');

  return project;
};
