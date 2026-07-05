import { IUserDocument } from '@bike4mind/common';
import { IRegInviteDocument } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/utils';

interface ListRegInviteAdapters {
  db: {
    regInvites: {
      findAll: () => Promise<IRegInviteDocument[]>;
    };
  };
}

export const listRegInvites = async (user: IUserDocument, { db }: ListRegInviteAdapters) => {
  if (!user.isAdmin) {
    throw new ForbiddenError('Permission denied');
  }

  return db.regInvites.findAll();
};
