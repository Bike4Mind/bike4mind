import { IFabFileRepository, ISessionRepository, IUserDocument, isImageServeable } from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const updateDocumentSharingSchema = z.object({
  id: z.string(),
  type: z.enum(['files', 'sessions']),
  isGlobalRead: z.boolean(),
  isGlobalWrite: z.boolean(),
});

type UpdateDocumentSharingParameters = z.infer<typeof updateDocumentSharingSchema>;

interface UpdateDocumentSharingAdapters {
  db: {
    sessions: Pick<ISessionRepository, 'shareable' | 'update'>;
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update'>;
  };
}

/**
 * Updates the sharing flags on a shareable document (currently FabFile or Session).
 * Write-access authorization (`shareable.findUpdateAccessById`) replaces the manager's
 * two CASL checks. Mirrors the app-level FabFile leak-gate: a file that is not
 * image-serveable has its `fileUrl`/`fileUrlExpireAt` stripped from the RESPONSE only
 * (after the write persists), so a held/blocked image never leaks a signed URL.
 */
export const updateDocumentSharing = async (
  user: IUserDocument,
  parameters: UpdateDocumentSharingParameters,
  { db }: UpdateDocumentSharingAdapters
) => {
  const { id, type, isGlobalRead, isGlobalWrite } = secureParameters(parameters, updateDocumentSharingSchema);

  const dbModel = type === 'files' ? db.fabFiles : db.sessions;

  const document = await dbModel.shareable.findUpdateAccessById(user, id);
  if (!document) throw new NotFoundError(`${type} not found for ${id}`);

  // findUpdateAccessById returns a hydrated Mongoose doc; normalize to a plain object
  // before mutating/returning (per organizationService.update) so the response shape is
  // correct and the field strip below actually takes effect.
  const plain = (
    typeof (document as { toJSON?: unknown }).toJSON === 'function'
      ? (document as unknown as { toJSON: () => Record<string, unknown> }).toJSON()
      : document
  ) as Record<string, unknown>;

  plain.isGlobalRead = isGlobalRead;
  plain.isGlobalWrite = isGlobalWrite;

  await dbModel.update(plain as never);

  // Strip on a copy so the persisted write keeps the real URL; only the response hides it.
  if (type === 'files' && !isImageServeable(plain)) {
    return { ...plain, fileUrl: undefined, fileUrlExpireAt: undefined };
  }

  return plain;
};
