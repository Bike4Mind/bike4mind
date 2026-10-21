import type { IProject, ProjectResource } from '@bike4mind/common';

/** The project fields the public shape may read. Anything else on the document never reaches `/api/v1`. */
export type PublicProjectSource = Pick<IProject, 'id' | 'name' | 'description'> &
  Partial<Pick<IProject, 'sessionIds' | 'fileIds' | 'createdAt' | 'updatedAt'>>;

const toIso = (value: Date | string | undefined | null): string | null => {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Allowlist projection onto the public `ProjectResource` (schemas/projectPublic.ts). Built field by
 * field, never by spreading the document, so sharing state and system prompts cannot leak.
 */
export function toPublicProject(project: PublicProjectSource): ProjectResource {
  return {
    id: String(project.id),
    name: project.name,
    description: project.description,
    session_ids: (project.sessionIds ?? []).map(String),
    file_ids: (project.fileIds ?? []).map(String),
    created_at: toIso(project.createdAt),
    updated_at: toIso(project.updatedAt),
  };
}
