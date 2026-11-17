import type { IArtifactDocument } from '@bike4mind/common';

export type ArtifactSource =
  { kind: 'notebook'; sessionId: string } | { kind: 'project'; projectId: string } | { kind: 'standalone' };

/** Where an artifact was filed: a notebook wins over a project; neither means it was created on its own (API, CLI). */
export function getArtifactSource(artifact: Pick<IArtifactDocument, 'sessionId' | 'projectId'>): ArtifactSource {
  if (artifact.sessionId) return { kind: 'notebook', sessionId: artifact.sessionId };
  if (artifact.projectId) return { kind: 'project', projectId: artifact.projectId };
  return { kind: 'standalone' };
}

export const ARTIFACT_SOURCE_LABEL: Record<ArtifactSource['kind'], string> = {
  notebook: 'Notebook',
  project: 'Project',
  standalone: 'Standalone',
};
