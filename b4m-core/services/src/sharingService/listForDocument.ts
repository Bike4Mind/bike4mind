import { IInviteDocument, IInviteRepository, InviteType, IUserDocument } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { authorizeByInviteType, InviteTypeAuthAdapters } from './authorizeByInviteType';

const listInvitesForDocumentSchema = z.object({
  documentId: z.string(),
  type: z.enum(InviteType),
});

type ListInvitesForDocumentParameters = z.infer<typeof listInvitesForDocumentSchema>;

interface ListInvitesForDocumentAdapters {
  db: InviteTypeAuthAdapters & {
    invites: Pick<IInviteRepository, 'findAllByDocumentId'>;
  };
}

/**
 * Lists every invite on a shareable document, filtered to the given type. Share-scoped
 * via `authorizeByInviteType` (owner / users-share / groups-share, replacing the
 * app-level CASL `Permission.share`).
 */
export const listInvitesForDocument = async (
  user: IUserDocument,
  parameters: ListInvitesForDocumentParameters,
  { db }: ListInvitesForDocumentAdapters
): Promise<IInviteDocument[]> => {
  const { documentId, type } = secureParameters(parameters, listInvitesForDocumentSchema);

  await authorizeByInviteType(user, type, documentId, db);

  const invites = await db.invites.findAllByDocumentId(documentId);
  return invites.filter(invite => invite.type === type);
};
