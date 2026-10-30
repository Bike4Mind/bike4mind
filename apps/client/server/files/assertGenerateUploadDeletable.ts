import { fabFileRepository } from '@bike4mind/database';
import { isOwnedGenerateUpload } from '@bike4mind/server-utils/files/generateUploadMarker';
import { throwFilesWriteRequired } from '@server/files/fileScopes';
import type { Request } from 'express';

/**
 * The DELETE twin of loadGenerateUploadFile: an `ai:generate`-only key may delete only its own
 * live, marked staging upload; anything else gets the ordinary files:write refusal. That is a 403
 * where the GET twin answers 404 - the caller is told which scope it lacks rather than being
 * left to guess, and every non-qualifying id still gets the same answer, so nothing enumerates.
 *
 * `id` must already be a valid ObjectId: the route's malformed-id guard runs first.
 */
export async function assertGenerateUploadDeletable(req: Request, id: string): Promise<void> {
  const file = await fabFileRepository.findById(id);
  if (!isOwnedGenerateUpload(file, req.user.id)) throwFilesWriteRequired();
}
