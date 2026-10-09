import { z } from 'zod';
import { PaginationQuerySchema, paginatedResponseSchema } from './pagination';

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
  /** Size in bytes of the file you will PUT. Checked against the upload limit and your storage quota. */
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
    file_name: z.string().min(1).optional(),
    notes: z.string().optional(),
  })
  .strict();

export type UpdateFileRequest = z.infer<typeof UpdateFileRequestSchema>;

/** GET /api/v1/quests/{id}/files. Named `files`, not `data`: bounded by the quest, so it is not paginated. */
export const ListQuestFilesResponseSchema = z.object({
  files: z.array(FileResponseSchema),
});

export type ListQuestFilesResponse = z.infer<typeof ListQuestFilesResponseSchema>;
