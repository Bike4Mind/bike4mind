import { IUserDocument, hasDeveloperUserTag } from '@bike4mind/common';

export const userIsDeveloper = (user: IUserDocument | null): boolean => {
  if (!user) return false;

  return hasDeveloperUserTag(user.tags);
};

export const userIsAnalyst = (user: IUserDocument | null): boolean => {
  if (!user) return false;

  // Developers should be able to do everything an analyst can do
  if (userIsDeveloper(user)) return true;

  return (user?.tags ?? []).some(tag => ['Analyst', 'analyst', 'Analysts', 'analysts'].includes(tag));
};

export const userIsOpti = (user: IUserDocument | null): boolean => {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (userIsDeveloper(user)) return true;
  return (user?.tags ?? []).some(tag => ['Opti', 'opti'].includes(tag));
};

export const userIsCustomer = (user: IUserDocument | null): boolean => {
  if (!user) return false;

  return (user?.tags ?? []).some(tag => ['Customer', 'customer', 'Customers', 'customers'].includes(tag));
};

export function getLastLoginDate(user: IUserDocument | undefined): Date | null {
  if (!user) return null;
  const lastLogin = user.loginRecords?.reduce(
    (acc, curr) => (acc.loginTime > curr.loginTime ? acc : curr),
    user.loginRecords[0]
  );
  return lastLogin ? new Date(lastLogin.loginTime) : null;
}

// TODO: Move to server config instead of per user. Share permissions is enough to disallow sharing of a single user
// export const userHasSharing = (user: IUserDocument | null): boolean => {
//   if (!user) return false;
//
//   return (user?.tags ?? []).includes('sharing') ?? false;
// };
