import { IInvite, InviteType } from '@bike4mind/common';
import { secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const listInviteByDocumentIdAndTypeSchema = z.object({
  documentId: z.string(),
  type: z.enum(InviteType),
});

type ListInviteByDocumentIdAndTypeParameters = z.infer<typeof listInviteByDocumentIdAndTypeSchema>;

interface ListInviteByIdAndTypeAdapters {
  db: {
    invites: {
      findAllByDocumentIdAndTypeAndUserId: (id: string, type: InviteType, userId: string) => Promise<IInvite[]>;
    };
  };
}

export const listInviteByDocumentIdAndType = async (
  userId: string,
  params: ListInviteByDocumentIdAndTypeParameters,
  { db }: ListInviteByIdAndTypeAdapters
) => {
  const { documentId, type } = secureParameters(params, listInviteByDocumentIdAndTypeSchema);

  const invites = await db.invites.findAllByDocumentIdAndTypeAndUserId(documentId, type, userId);

  return invites;
};
