import type { IArtifactDocument, IArtifactVersionDocument } from '@bike4mind/common';

/** What a reader who has no grant on an artifact (it is only public) may see. No owner, org or permission data. */
export type ArtifactViewerView = Pick<
  IArtifactDocument,
  | 'id'
  | 'type'
  | 'title'
  | 'description'
  | 'version'
  | 'versionTag'
  | 'status'
  | 'tags'
  | 'visibility'
  | 'identifier'
  | 'metadata'
  | 'contentHash'
  | 'contentSize'
  | 'createdAt'
  | 'updatedAt'
  | 'publishedAt'
>;

export type ArtifactViewerVersion = Omit<IArtifactVersionDocument, 'createdBy'>;

/** Built field by field, never spread, so a field added to the document later stays private by default. */
export function toArtifactViewerView(artifact: IArtifactDocument): ArtifactViewerView {
  return {
    id: artifact.id,
    type: artifact.type,
    title: artifact.title,
    description: artifact.description,
    version: artifact.version,
    versionTag: artifact.versionTag,
    status: artifact.status,
    tags: artifact.tags,
    visibility: artifact.visibility,
    identifier: artifact.identifier,
    metadata: artifact.metadata,
    contentHash: artifact.contentHash,
    contentSize: artifact.contentSize,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    publishedAt: artifact.publishedAt,
  };
}

/** Generic so repository rows (ObjectId ids) and plain documents both fit; only the author is dropped. */
export function toArtifactViewerVersion<T extends { createdBy?: unknown }>(version: T): Omit<T, 'createdBy'> {
  const { createdBy: _author, ...rest } = version;
  return rest;
}
