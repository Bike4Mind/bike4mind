import { resolveSupportedMimeType } from '@bike4mind/utils';
import { BARE_UPLOAD_MAX_BYTES, BARE_UPLOAD_MIME_TYPE } from '@server/files/generateUploadMarker';
import { throwFilesWriteRequired } from '@server/files/fileScopes';

/**
 * The only body fields an `ai:generate` key without `files:write` may send to
 * generate-presigned-url. An allowlist, so a field added to the request schema later is denied to
 * these keys until it is added here.
 */
const BARE_UPLOAD_FIELDS: ReadonlySet<string> = new Set(['fileName', 'mimeType', 'fileSize']);

export { BARE_UPLOAD_MAX_BYTES };

const BARE_UPLOAD_MAX_NAME_LENGTH = 255;

/** Throws the files:write 403 unless the request is a plain, small PNG upload with nothing attached. */
export function assertBareGenerateUploadBody(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throwFilesWriteRequired();
  const fields = body as Record<string, unknown>;

  if (Object.keys(fields).some(k => fields[k] != null && !BARE_UPLOAD_FIELDS.has(k))) throwFilesWriteRequired();

  const { fileName, mimeType, fileSize } = fields;
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > BARE_UPLOAD_MAX_NAME_LENGTH) {
    throwFilesWriteRequired();
  }
  if (mimeType !== BARE_UPLOAD_MIME_TYPE) throwFilesWriteRequired();
  if (resolveSupportedMimeType(fileName, mimeType).mimeType !== BARE_UPLOAD_MIME_TYPE) throwFilesWriteRequired();
  if (
    typeof fileSize !== 'number' ||
    !Number.isInteger(fileSize) ||
    fileSize <= 0 ||
    fileSize > BARE_UPLOAD_MAX_BYTES
  ) {
    throwFilesWriteRequired();
  }
}
