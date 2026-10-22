import { z } from 'zod';
import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

// ── Lake Skipped File ────────────────────────────────────────────────────────
//
// A file a connected source (Drive folder, GitHub repo) holds that the lake sync refused to ingest,
// with the reason. Keyed per lake rather than per batch: every sync mints a new batch and finished
// batches drop out of every read, so a batch-scoped list would vanish on the next sync. The row is
// upserted on each skip and deleted when the file later ingests or leaves the source, so the
// collection always reads as "what is missing right now". An edited file that fails a gate gets a
// row too, even though its previous version stays a lake member: the current version is missing.

/** Every reason a lake sync can refuse a file. Producers and the UI copy map share this one list. */
export const LAKE_SKIPPED_FILE_REASONS = [
  // Listed size is over the per-file hard cap, before any bytes are fetched.
  'oversized',
  // Over the admin `MaxFileSize` setting.
  'exceeds_max_file_size',
  // Fetched bytes turned out larger than the listed size allowed.
  'oversized_after_fetch',
  // Drive: a type with no download or export path (Forms, shortcuts, ...).
  'unsupported',
  // Drive: a Google-native doc whose export exceeds Drive's export cap.
  'export_too_large',
  // Drive: the fetch failed for a non-rate-limit reason.
  'error',
  // The lake owner's storage quota is full. Retried on a later sync once space is freed.
  'storage_limit',
  // GitHub: content is not text (see `checkLakeFileContent`).
  'binary',
  'invalid_utf8',
] as const;

export const LakeSkippedFileReasonSchema = z.enum(LAKE_SKIPPED_FILE_REASONS);
export type LakeSkippedFileReason = z.infer<typeof LakeSkippedFileReasonSchema>;

export const LAKE_SKIPPED_FILE_SOURCE_KINDS = ['google_drive', 'github'] as const;
export const LakeSkippedFileSourceKindSchema = z.enum(LAKE_SKIPPED_FILE_SOURCE_KINDS);
export type LakeSkippedFileSourceKind = z.infer<typeof LakeSkippedFileSourceKindSchema>;

export const LakeSkippedFile = z.object({
  dataLakeId: z.string(),
  sourceKind: LakeSkippedFileSourceKindSchema,
  /** The source's stable file key: the Drive file id, or the repo-relative path for GitHub. */
  sourceId: z.string(),
  name: z.string(),
  relativePath: z.string().optional(),
  mimeType: z.string().optional(),
  /** Bytes, when the source reported a size. */
  size: z.number().optional(),
  reason: LakeSkippedFileReasonSchema,
  firstSeenAt: z.date(),
  lastSeenAt: z.date(),
});
export type ILakeSkippedFile = z.infer<typeof LakeSkippedFile>;

export interface ILakeSkippedFileDocument extends ILakeSkippedFile, IMongoDocument {}

/** What a producer reports at skip time; the repository owns the timestamps. */
export type LakeSkippedFileInput = Omit<ILakeSkippedFile, 'firstSeenAt' | 'lastSeenAt'> & {
  /** relativePath is only the file name; keep a stored path and use this only on insert. */
  relativePathIsPartial?: boolean;
};

export interface ILakeSkippedFileRepository extends IBaseRepository<ILakeSkippedFileDocument> {
  /**
   * Record a skip, or refresh the existing row for (dataLakeId, sourceKind, sourceId) in place.
   * Idempotent on that key (unique index), so a file re-skipped on every full walk stays one row;
   * `firstSeenAt` is kept, everything else takes the latest skip's values.
   */
  recordSkip(input: LakeSkippedFileInput): Promise<void>;
  /** `recordSkip` for many files in one round trip; same per-row semantics. */
  recordSkips(inputs: readonly LakeSkippedFileInput[]): Promise<void>;
  /** Drop the rows for these source ids, e.g. once they ingest or the source reports them removed. */
  clearSources(
    dataLakeId: string,
    sourceKind: LakeSkippedFileSourceKind,
    sourceIds: readonly string[]
  ): Promise<number>;
  /**
   * Drop every row whose source id is NOT in `presentSourceIds` - the cleanup for a sync that saw the
   * whole source (Drive full walk, GitHub tree). The caller must not pass an empty set for a walk it
   * does not trust (a transient empty listing would wipe the list).
   */
  pruneMissing(
    dataLakeId: string,
    sourceKind: LakeSkippedFileSourceKind,
    presentSourceIds: ReadonlySet<string>
  ): Promise<number>;
  /**
   * Most recently first-skipped first. Keyed on `firstSeenAt`, which a re-skip never moves, so a
   * full walk refreshing every row between two page loads does not reshuffle offset paging.
   */
  listByLake(dataLakeId: string, options: { limit: number; offset: number }): Promise<ILakeSkippedFileDocument[]>;
  countByLake(dataLakeId: string): Promise<number>;
  /** Connector disconnect: the source's files are no longer the lake's concern. */
  deleteForSource(dataLakeId: string, sourceKind: LakeSkippedFileSourceKind): Promise<number>;
  deleteForLake(dataLakeId: string): Promise<number>;
}

/** Wire shape of one row from `GET /api/data-lakes/[id]/skipped-files`. */
export type LakeSkippedFileView = {
  id: string;
  sourceKind: LakeSkippedFileSourceKind;
  sourceId: string;
  name: string;
  relativePath?: string;
  mimeType?: string;
  size?: number;
  reason: LakeSkippedFileReason;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type LakeSkippedFilesResponse = {
  data: LakeSkippedFileView[];
  /** Total rows for the lake, independent of the page, so a count above the page size stays exact. */
  total: number;
  hasMore: boolean;
};
