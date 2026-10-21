/** Stored under `sourceMetadata.uploadedVia` on a file an ai:generate-only key uploaded. */
export const GENERATE_UPLOAD_MARKER = 'ai-generate-key-upload';

/** The image-edit flow uploads PNG bytes only (mask and source). */
export const BARE_UPLOAD_MIME_TYPE = 'image/png';

/** Well above a generated PNG, well below the global MaxFileSize default. */
export const BARE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

export const GENERATE_UPLOAD_BLOCK_REASON = 'generate_upload_constraint';

/**
 * Present only for a file an ai:generate-only key uploaded. Every moderation scan passes it to
 * moderateUploadedFile, which is the one place a verdict is produced, so a marked file cannot
 * resolve clean unless it is a PNG within the cap.
 */
export type GenerateUploadConstraint = { measureSize: () => Promise<number> };

export function generateUploadConstraintFor(
  sourceMetadata: unknown,
  measureSize: () => Promise<number>
): GenerateUploadConstraint | undefined {
  const uploadedVia = (sourceMetadata as { uploadedVia?: unknown } | null | undefined)?.uploadedVia;
  return uploadedVia === GENERATE_UPLOAD_MARKER ? { measureSize } : undefined;
}
