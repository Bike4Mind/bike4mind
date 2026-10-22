import { FabFileSourceType } from './types/entities/FabFileTypes';

/**
 * One `$group` row of a user's charged storage, as FabFileRepository.summarizeChargedStorageByUserId
 * returns it. `sourceLakeId` is kept only for the lake-ingest sources and `mimeType` only for
 * generated files, so the group count stays small however many files the user has.
 */
export interface StorageUsageGroup {
  sourceType: string | null;
  sourceLakeId: string | null;
  mimeType: string | null;
  archived: boolean;
  bytes: number;
  fileCount: number;
}

export type GeneratedMediaKind = 'image' | 'audio' | 'video' | 'document' | 'other';

export interface StorageBreakdownBucket {
  key: string;
  sourceType: FabFileSourceType;
  /** Set for Drive/GitHub buckets; absent for files ingested before `sourceLakeId` was stamped. */
  lakeId?: string;
  /** Resolved by the service; null unless the lake is the caller's own and still live. */
  lakeName?: string | null;
  /** Set for generated-file buckets only. */
  mediaKind?: GeneratedMediaKind;
  bytes: number;
  fileCount: number;
  /** The archived share of `bytes`/`fileCount` - archived files still count toward the counter. */
  archivedBytes: number;
  archivedFileCount: number;
}

export interface StorageBreakdownResponse {
  /** The user's `currentStorageSize` counter - the figure the usage bar shows. */
  totalBytes: number;
  /** Sum of every bucket: the counter's own row definition (sumFileSizeByUserId) recomputed now. */
  accountedBytes: number;
  /** `totalBytes - accountedBytes`. Non-zero means the incremental counter has drifted; can be negative. */
  unaccountedBytes: number;
  /** Largest first. */
  buckets: StorageBreakdownBucket[];
}

/** Sources whose rows carry `sourceLakeId`. Also drives FabFileRepository.summarizeChargedStorageByUserId. */
export const LAKE_INGEST_SOURCE_TYPES: readonly FabFileSourceType[] = [
  FabFileSourceType.GOOGLE_DRIVE,
  FabFileSourceType.GITHUB,
];
const LAKE_SOURCES: ReadonlySet<string> = new Set(LAKE_INGEST_SOURCE_TYPES);
const KNOWN_SOURCES: ReadonlySet<string> = new Set(Object.values(FabFileSourceType));
const DOCUMENT_MIME_TYPES =
  /^(text\/|application\/(pdf|json|xml|msword|rtf|vnd\.openxmlformats-officedocument\.|vnd\.oasis\.opendocument\.|vnd\.ms-(excel|powerpoint)))/;

export const isLakeIngestSource = (sourceType: string | null | undefined): boolean =>
  !!sourceType && LAKE_SOURCES.has(sourceType);

export function generatedMediaKindOf(mimeType: string | null | undefined): GeneratedMediaKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (DOCUMENT_MIME_TYPES.test(mime)) return 'document';
  return 'other';
}

/**
 * Folds the `$group` rows into display buckets. A row with no `sourceType` (legacy, see the
 * FabFile schema's provenance comment) is a manual upload: provenance was only ever stamped on the
 * non-manual paths.
 */
export function buildStorageBreakdownBuckets(groups: StorageUsageGroup[]): StorageBreakdownBucket[] {
  const buckets = new Map<string, StorageBreakdownBucket>();
  for (const group of groups) {
    const sourceType = (
      group.sourceType && KNOWN_SOURCES.has(group.sourceType) ? group.sourceType : FabFileSourceType.MANUAL_UPLOAD
    ) as FabFileSourceType;
    let key: string = sourceType;
    const partial: Pick<StorageBreakdownBucket, 'lakeId' | 'mediaKind'> = {};
    if (isLakeIngestSource(sourceType) && group.sourceLakeId) {
      key = `${sourceType}:${group.sourceLakeId}`;
      partial.lakeId = group.sourceLakeId;
    } else if (sourceType === FabFileSourceType.TOOL_GENERATED) {
      partial.mediaKind = generatedMediaKindOf(group.mimeType);
      key = `${sourceType}:${partial.mediaKind}`;
    }
    const bucket = buckets.get(key) ?? {
      key,
      sourceType,
      ...partial,
      bytes: 0,
      fileCount: 0,
      archivedBytes: 0,
      archivedFileCount: 0,
    };
    bucket.bytes += group.bytes;
    bucket.fileCount += group.fileCount;
    if (group.archived) {
      bucket.archivedBytes += group.bytes;
      bucket.archivedFileCount += group.fileCount;
    }
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}
