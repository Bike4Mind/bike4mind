import { z } from 'zod';

/**
 * Public wire schemas for `POST /api/v1/files` (start an upload) and
 * `GET /api/v1/files/{id}` (read one file back, with a download URL).
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
