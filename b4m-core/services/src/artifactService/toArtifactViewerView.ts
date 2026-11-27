import type { ArtifactType, IArtifactDocument } from '@bike4mind/common';

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

const VIEWER_METADATA_KEYS: Partial<Record<ArtifactType, readonly string[]>> = {
  react: ['hasDefaultExport', 'errorBoundary'],
  html: ['allowedScripts', 'cspPolicy', 'sanitized'],
  svg: ['viewBox', 'width', 'height', 'sanitized'],
  mermaid: ['chartType', 'description'],
  recharts: ['chartType', 'description', 'dataPoints', 'width', 'height', 'xAxis', 'yAxis', 'colors'],
  python: ['packages', 'hasOutput', 'executionState', 'lastExecutionTime'],
  chess: ['fen', 'turn', 'lastMove', 'isCheck', 'isCheckmate', 'isDraw', 'isGameOver', 'moveNumber'],
  lattice: ['modelType', 'periodGrain', 'currency', 'entityCount', 'ruleCount', 'lastComputedAt'],
};

function toViewerMetadata(artifact: IArtifactDocument): IArtifactDocument['metadata'] {
  if (!artifact.metadata) return undefined;
  const metadata: Record<string, unknown> = {};
  // Free-form settings/props are not read by the viewer; only display fields cross this boundary.
  const keys = ['language', 'dependencies', ...(VIEWER_METADATA_KEYS[artifact.type] ?? [])];
  for (const key of keys) {
    if (Object.hasOwn(artifact.metadata, key)) metadata[key] = artifact.metadata[key];
  }
  if (artifact.type === 'chess' && typeof metadata.lastMove === 'object' && metadata.lastMove !== null) {
    const lastMove = metadata.lastMove as Record<string, unknown>;
    metadata.lastMove = Object.fromEntries(
      ['from', 'to', 'san'].filter(key => Object.hasOwn(lastMove, key)).map(key => [key, lastMove[key]])
    );
  }
  return metadata;
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
    metadata: toViewerMetadata(artifact),
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
