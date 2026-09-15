import z from 'zod';
import { IFabFile, KnowledgeType } from '../types';

/**
 * Content types a browser executes as an active document on the origin that serves them.
 * Uploaded bytes are served from S3/CDN with no per-file CSP, so any of these declared as
 * the stored Content-Type is stored XSS when the file is opened. Rejected at every upload
 * boundary; presign routes must also bind ContentType so the declared type cannot be
 * swapped for one of these at PUT time.
 */
export const EXECUTABLE_UPLOAD_MIME_TYPES: readonly string[] = ['text/html', 'application/xhtml+xml', 'image/svg+xml'];

/** Normalize `type/subtype; charset=...` to a bare lowercased `type/subtype`. */
const bareMimeType = (mimeType: string): string => mimeType.split(';')[0].trim().toLowerCase();

export const isExecutableUploadMimeType = (mimeType: string): boolean =>
  EXECUTABLE_UPLOAD_MIME_TYPES.includes(bareMimeType(mimeType));

/**
 * Raster/vector image types accepted for image-only uploads (org logos, avatars).
 * image/svg+xml is deliberately excluded - see EXECUTABLE_UPLOAD_MIME_TYPES.
 */
export const ALLOWED_IMAGE_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/tiff',
];

export const isAllowedImageMimeType = (mimeType: string): boolean =>
  ALLOWED_IMAGE_MIME_TYPES.includes(bareMimeType(mimeType));

export const FileGeneratePresignedUrlRequestInput = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  /** The path to the file */
  path: z.string().optional(),
  /** SHA-256 content hash for deduplication */
  contentHash: z.string().optional(),
  /** Batch ID for data lake uploads */
  batchId: z.string().optional(),
  /** Original relative path from folder upload */
  relativePath: z.string().optional(),
  /** Tags to apply to the file on creation */
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
});
export type FileGeneratePresignedUrlRequestInputType = z.infer<typeof FileGeneratePresignedUrlRequestInput>;

export type FileGeneratePresignedUrlResponseType = {
  url: string;
  fileKey: string;
  fileId: string;
};

export const CreateFabFileRequestInput = z.object({
  type: z.nativeEnum(KnowledgeType),
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  fileContent: z.string().optional(),
  /** Set to true if the file should be publicly accessible */
  public: z.boolean().optional(),
  /** The prefix to use for the file path */
  prefix: z.string().optional(),
});

export type CreateFabFileRequestInputType = z.infer<typeof CreateFabFileRequestInput>;
export type UpdateFabFileRequestInputType = Partial<IFabFile & { fileContent?: string }>;
