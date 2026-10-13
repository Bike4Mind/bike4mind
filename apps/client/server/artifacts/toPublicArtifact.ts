import type { ArtifactResource, ArtifactVersion } from '@bike4mind/common';

/** The Artifact fields the public shape may read. Anything else on the document never reaches `/api/v1`. */
export interface PublicArtifactSource {
  id: string;
  type: ArtifactResource['type'];
  title: string;
  description?: string | null;
  version?: number | null;
  versionTag?: string | null;
  status?: string | null;
  tags?: string[] | null;
  sessionId?: string | null;
  projectId?: string | null;
  visibility?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface PublicArtifactVersionSource {
  version: number;
  versionTag?: string | null;
  changeDescription?: string | null;
  createdAt: Date | string;
}

/**
 * Allowlist projection onto schemas/artifactPublic.ts. Built field by field, never by spreading the
 * document, so permissions, owner ids, content pointers and metadata cannot leak. `content` is null
 * on list items.
 */
export function toPublicArtifact(artifact: PublicArtifactSource, content: string | null): ArtifactResource {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    description: artifact.description ?? null,
    version: artifact.version ?? 1,
    version_tag: artifact.versionTag ?? null,
    status: (artifact.status ?? 'draft') as ArtifactResource['status'],
    tags: artifact.tags ?? [],
    session_id: artifact.sessionId ?? null,
    project_id: artifact.projectId ?? null,
    visibility: (artifact.visibility ?? 'private') as ArtifactResource['visibility'],
    created_at: new Date(artifact.createdAt).toISOString(),
    updated_at: new Date(artifact.updatedAt).toISOString(),
    content,
  };
}

export function toPublicArtifactVersion(version: PublicArtifactVersionSource, content: string | null): ArtifactVersion {
  return {
    version: version.version,
    version_tag: version.versionTag ?? null,
    change_description: version.changeDescription ?? null,
    created_at: new Date(version.createdAt).toISOString(),
    content,
  };
}
