import { z } from 'zod';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';
import { MIN_PASSAGE_TOKEN_TARGET, OVERSIZED_PASSAGE_TOKEN_THRESHOLD } from '../constants/chunking';
import { FAB_FILE_TYPE_FILTERS } from '../types/entities/FabFileTypes';

/**
 * Public wire schemas for the `/api/v1/files` endpoints: start an upload, list, read one file back
 * (with a download URL), update and delete.
 *
 * A deliberately narrow projection of the FabFile document the SPA-internal
 * `/api/files/*` routes return: no owner, sharing, tag, or chunking fields, so
 * those stay free to change without a breaking API change.
 *
 * Public-API rules apply: snake_case wire fields, no `.catch()`, no top-level
 * `.transform()`.
 */

export const CreateFileUploadRequestSchema = z.object({
  /** Original file name, extension included - used to resolve the stored type. */
  file_name: z.string().min(1),
  /** Declared MIME type, e.g. `image/png`. Unsupported types are rejected with 400. */
  mime_type: z.string().min(1),
  /**
   * Size in bytes of the file you will PUT. Checked against the upload limit and your storage quota,
   * and bound into `upload_url`: a PUT of any other length is refused.
   */
  file_size: z.number().int().positive(),
});

export type CreateFileUploadRequest = z.infer<typeof CreateFileUploadRequestSchema>;

export const FILE_MODERATION_STATUSES = ['pending', 'scanning', 'clean', 'blocked'] as const;

export const CreateFileUploadResponseSchema = z.object({
  /** The new file's id. Pass it wherever an endpoint takes a file id, and poll `GET /api/v1/files/{id}`. */
  id: z.string(),
  /** Presigned URL to `PUT` the raw file bytes to. No auth header - the signature is the credential. */
  upload_url: z.string(),
  /** ISO 8601. The upload URL stops working after this; request a new upload to retry. */
  upload_url_expires_at: z.string(),
});

export type CreateFileUploadResponse = z.infer<typeof CreateFileUploadResponseSchema>;

export const FileIdParamSchema = z.object({
  id: z.string().min(1),
});

export const FileResponseSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  /** Bytes. */
  file_size: z.number(),
  /**
   * Every file is scanned once its bytes land, whatever its type: `pending` until then (so this is
   * also the upload's progress), `clean` once downloadable, `blocked` if it never will be. `null`
   * only on records that predate scanning.
   */
  moderation_status: z.enum(FILE_MODERATION_STATUSES).nullable(),
  /**
   * Short-lived signed URL to GET the file bytes. `null` until `moderation_status` is `clean` -
   * re-read this endpoint rather than caching the URL.
   */
  download_url: z.string().nullable(),
  /** ISO 8601. When `download_url` stops working; `null` whenever `download_url` is. */
  download_url_expires_at: z.string().nullable(),
  /** ISO 8601. */
  created_at: z.string(),
});

export type FileResponse = z.infer<typeof FileResponseSchema>;

/** A list item: the file without its download fields, so a page never presigns N URLs. */
export const FileSummarySchema = FileResponseSchema.omit({ download_url: true, download_url_expires_at: true });

export type FileSummary = z.infer<typeof FileSummarySchema>;

export const ListFilesQuerySchema = PaginationQuerySchema.extend({
  /** Case-insensitive substring match on the file name. Not part of the cursor: resend it with every page. */
  search: z.string().min(1).max(200).optional(),
});

export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;

export const ListFilesResponseSchema = paginatedResponseSchema(FileSummarySchema);

export type ListFilesResponse = z.infer<typeof ListFilesResponseSchema>;

/** Omitted fields are left unchanged; unknown fields are rejected. */
export const UpdateFileRequestSchema = z
  .object({
    file_name: z.string().trim().min(1).max(255).optional(),
    /** An empty string clears the notes. */
    notes: z.string().max(10_000).optional(),
  })
  .strict();

export type UpdateFileRequest = z.infer<typeof UpdateFileRequestSchema>;

/** GET /api/v1/quests/{id}/files. Named `files`, not `data`: bounded by the quest, so it is not paginated. */
export const ListQuestFilesResponseSchema = z.object({
  files: z.array(FileResponseSchema),
});

export type ListQuestFilesResponse = z.infer<typeof ListQuestFilesResponseSchema>;

/** POST /api/v1/files/{id}/chunk. */
export const ChunkFileRequestSchema = z.object({
  /** Passage target in tokens, inclusive bounds. Out-of-range values are rejected, never clamped. */
  chunk_size: z.number().int().min(MIN_PASSAGE_TOKEN_TARGET).max(OVERSIZED_PASSAGE_TOKEN_THRESHOLD),
});

export type ChunkFileRequest = z.infer<typeof ChunkFileRequestSchema>;

export const ChunkFileResponseSchema = z.object({
  /** Id of the queued chunking job. Chunking runs in the background and there is no endpoint to poll it. */
  message_id: z.string(),
});

export type ChunkFileResponse = z.infer<typeof ChunkFileResponseSchema>;

/** Upper bound on one `by-ids` lookup and one bulk delete, so a request cannot fan out unboundedly. */
export const MAX_FILE_IDS_PER_REQUEST = 100;

/** GET /api/v1/files/search. Not paginated: it returns the best `limit` matches, so narrow with `q` and `type`. */
export const SearchFilesQuerySchema = z.object({
  /** Case-insensitive substring match on the file name. Omit to list by name. */
  q: z.string().min(1).max(200).optional(),
  type: z.enum(FAB_FILE_TYPE_FILTERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type SearchFilesQuery = z.infer<typeof SearchFilesQuerySchema>;

/** Named `files`, not `data`: bounded by `limit`, so it is not a paginated list. */
export const SearchFilesResponseSchema = z.object({
  files: z.array(FileResponseSchema),
});

export type SearchFilesResponse = z.infer<typeof SearchFilesResponseSchema>;

/** GET /api/v1/files/by-ids. */
export const FilesByIdsQuerySchema = z.object({
  /** Comma-separated file ids, at most 100. */
  ids: z.string().min(1),
});

export type FilesByIdsQuery = z.infer<typeof FilesByIdsQuerySchema>;

/** Ids the caller cannot see, or that do not exist, are simply absent. Bounded by the id cap, so not paginated. */
export const FilesByIdsResponseSchema = z.object({
  files: z.array(FileResponseSchema),
});

export type FilesByIdsResponse = z.infer<typeof FilesByIdsResponseSchema>;

/** POST /api/v1/files/bulk-delete. */
export const BulkDeleteFilesRequestSchema = z.object({
  file_ids: z.array(z.string().min(1)).min(1).max(MAX_FILE_IDS_PER_REQUEST),
});

export type BulkDeleteFilesRequest = z.infer<typeof BulkDeleteFilesRequestSchema>;

/** Every requested id lands in exactly one bucket. */
export const BulkDeleteFilesResponseSchema = z.object({
  /** Files you owned, now deleted. */
  deleted: z.array(z.string()),
  /** Files shared with you: only your access was removed. */
  unshared: z.array(z.string()),
  not_found: z.array(z.string()),
  /** Ids that could not be processed; retry them. */
  failed: z.array(z.object({ id: z.string(), error: z.string() })),
});

export type BulkDeleteFilesResponse = z.infer<typeof BulkDeleteFilesResponseSchema>;
