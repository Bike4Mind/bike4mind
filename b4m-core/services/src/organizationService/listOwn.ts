import { IOrganizationRepository, IUserDocument } from '@bike4mind/common';

interface ListOwnAdapters {
  db: {
    organizations: IOrganizationRepository;
  };
}

export const listOwn = (user: IUserDocument, adapters: ListOwnAdapters) => {
  return adapters.db.organizations.shareable.findAllAccessible(user);
};
