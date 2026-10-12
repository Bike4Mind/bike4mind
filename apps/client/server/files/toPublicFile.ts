import { isImageServeable, type FileResponse, type FileSummary, type IFabFile } from '@bike4mind/common';

/** The FabFile fields the public shapes may read. Anything else on the document never reaches `/api/v1`. */
export type PublicFileSource = Pick<IFabFile, 'fileName' | 'mimeType' | 'fileSize'> &
  Partial<Pick<IFabFile, 'moderationStatus' | 'fileUrl' | 'fileUrlExpireAt'>> & {
    id: unknown;
    createdAt: Date | string;
  };

/**
 * Allowlist projection onto the public list item (schemas/publicFile.ts). Built field by field, never
 * by spreading the document, so owner, sharing, tag and chunking fields cannot leak.
 */
export function toPublicFileSummary(fabFile: PublicFileSource): FileSummary {
  return {
    id: String(fabFile.id),
    file_name: fabFile.fileName,
    mime_type: fabFile.mimeType,
    file_size: fabFile.fileSize,
    moderation_status: fabFile.moderationStatus ?? null,
    created_at: new Date(fabFile.createdAt).toISOString(),
  };
}

/** The list item plus a download URL once the file is downloadable. Expects a freshly signed `fileUrl`. */
export function toPublicFile(fabFile: PublicFileSource): FileResponse {
  // Gated on moderation alone, not `status`: `clean` is only reached once the bytes were scanned,
  // while `status` stays `pending` forever on doors that never presign (see moderationRescueSweep).
  const downloadable = isImageServeable(fabFile) && !!fabFile.fileUrl;
  return {
    ...toPublicFileSummary(fabFile),
    download_url: downloadable ? fabFile.fileUrl! : null,
    download_url_expires_at:
      downloadable && fabFile.fileUrlExpireAt ? new Date(fabFile.fileUrlExpireAt).toISOString() : null,
  };
}
