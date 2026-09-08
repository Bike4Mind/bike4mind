import type { IFabFileDocument, IFabFileRepository, IUserDocument } from '@bike4mind/common';
import { NotFoundError } from '@bike4mind/utils';

type FabFileAccessDb = { db: { fabFiles: Pick<IFabFileRepository, 'shareable'> } };

/**
 * Object-level access guard for a caller-supplied FabFile id. Any endpoint that signs, copies,
 * downloads, or reads a file from an id/key taken off the request body/query must call this before
 * touching the object, or an authenticated caller can reach another user's file (IDOR).
 *
 * Reuses `shareable.findAccessibleById` - the SAME predicate `getFabFile` serves single files by
 * (owner OR per-user share OR per-group share; see SharableDocumentModel) - so this guard and the
 * file-viewer never disagree about who may read a file. `NotFoundError` on missing-or-not-yours
 * (never Forbidden) so a probe can't tell "doesn't exist" from "exists but isn't mine".
 *
 * Companion to dataLakeService.assertBatchOwnership; the shared home for file object-level authz.
 */
export const assertFabFileAccessById = async (
  user: IUserDocument,
  id: string,
  { db }: FabFileAccessDb
): Promise<IFabFileDocument> => {
  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, id);
  if (!fabFile) throw new NotFoundError('File not found');
  return fabFile;
};
