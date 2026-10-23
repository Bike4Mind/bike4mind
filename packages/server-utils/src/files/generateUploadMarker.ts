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
  return uploadedViaOf(sourceMetadata) === GENERATE_UPLOAD_MARKER ? { measureSize } : undefined;
}

/** The file fields the ownership gate reads - a structural subset of a FabFile document. */
export type GenerateUploadFileFields = {
  userId?: unknown;
  deletedAt?: unknown;
  sourceMetadata?: unknown;
};

/**
 * True only for a live, marked file owned by `userId`. Shared by the GET and DELETE doors so an
 * ai:generate-only key's reach cannot drift between reading its staged upload and deleting it.
 */
export function isOwnedGenerateUpload(
  file: GenerateUploadFileFields | null | undefined,
  userId: string
): file is GenerateUploadFileFields {
  if (!file || file.deletedAt) return false;
  return uploadedViaOf(file.sourceMetadata) === GENERATE_UPLOAD_MARKER && String(file.userId) === String(userId);
}

function uploadedViaOf(sourceMetadata: unknown): unknown {
  return (sourceMetadata as { uploadedVia?: unknown } | null | undefined)?.uploadedVia;
}
