import { IUserDocument } from '@bike4mind/common';
import { ForbiddenError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const deleteInviteCodesSchema = z.object({
  ids: z.array(z.string()),
});

type DeleteInviteCodesParameters = z.infer<typeof deleteInviteCodesSchema>;

interface DeleteInviteCodesAdapters {
  db: {
    regInvites: {
      deleteByIds: (ids: string[]) => Promise<void>;
    };
  };
}

export const deleteInviteCodes = async (
  user: IUserDocument,
  parameters: DeleteInviteCodesParameters,
  { db }: DeleteInviteCodesAdapters
) => {
  if (!user.isAdmin) throw new ForbiddenError('Permission denied');

  const { ids } = secureParameters(parameters, deleteInviteCodesSchema);

  await db.regInvites.deleteByIds(ids);
};
