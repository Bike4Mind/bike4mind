import type { IArtifactDocument } from '@bike4mind/common';

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

/** The version fields the version dropdown reads; the author and content ids are not among them. */
const VIEWER_VERSION_KEYS = [
  '_id',
  'artifactId',
  'version',
  'versionTag',
  'changes',
  'changeDescription',
  'createdAt',
  'isActive',
] as const;

export type ArtifactViewerVersion<T> = Pick<T, Extract<(typeof VIEWER_VERSION_KEYS)[number], keyof T>>;

/** Chat and agent writers copy the source quest id (and the desktop publisher a session id) into metadata. */
function omitQuestIds<M extends object>(metadata: M): M {
  const {
    questId: _q,
    desktopSessionId: _s,
    ...rest
  } = metadata as M & { questId?: unknown; desktopSessionId?: unknown };
  return rest as unknown as M;
}

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
    metadata: artifact.metadata && omitQuestIds(artifact.metadata),
    contentHash: artifact.contentHash,
    contentSize: artifact.contentSize,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    publishedAt: artifact.publishedAt,
  };
}

/** Generic so repository rows (ObjectId ids) and plain documents both fit; a field added to the version later stays private. */
export function toArtifactViewerVersion<T extends object>(version: T): ArtifactViewerVersion<T> {
  const out: Partial<T> = {};
  for (const key of VIEWER_VERSION_KEYS) {
    if (key in version) (out as Record<string, unknown>)[key] = (version as Record<string, unknown>)[key];
  }
  return out as ArtifactViewerVersion<T>;
}
