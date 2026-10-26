import { fabFileRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { NotFoundError } from '@bike4mind/utils';
import { buildFabFileAdapter } from '@server/files/loadAccessibleFabFile';
import { isOwnedGenerateUpload } from '@bike4mind/server-utils/files/generateUploadMarker';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import type { Request } from 'express';

/**
 * What an `ai:generate` key without `files:read` may read of a file: only the caller's own file
 * that an ai:generate-only key staged (see GENERATE_UPLOAD_MARKER), and only the fields the
 * upload-then-poll flow needs. Everything else is the same 404 a missing file gets.
 */
export async function loadGenerateUploadFile(req: Request, id: string) {
  if (!isValidObjectId(id)) throw new NotFoundError('Fabfile not found');

  const file = await fabFileRepository.findById(id);
  if (!isOwnedGenerateUpload(file, req.user.id)) {
    throw new NotFoundError('Fabfile not found');
  }

  const signed = await fabFilesService.generateSignedUrl(file, buildFabFileAdapter(req));
  return { id: file.id, moderationStatus: signed.moderationStatus, fileUrl: signed.fileUrl };
}
