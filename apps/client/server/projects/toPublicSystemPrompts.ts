import type { IProject, ProjectSystemPromptsResponse } from '@bike4mind/common';

export function toPublicSystemPrompts(project: Pick<IProject, 'systemPrompts'>): ProjectSystemPromptsResponse {
  return {
    system_prompts: (project.systemPrompts ?? []).map(prompt => ({
      file_id: String(prompt.fileId),
      enabled: !!prompt.enabled,
    })),
  };
}
