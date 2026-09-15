import { api } from '@client/app/contexts/ApiContext';
import { toCsv } from '@client/app/utils/csv';
import { downloadData } from '@client/app/utils/download';
import { getLastLoginDate } from '@client/app/utils/user';
import { IGetUsersParams, IGetUsersResponse } from '@client/app/utils/userAPICalls';

const CSV_HEADERS = [
  'Name',
  'Organization',
  'Username',
  'Email',
  'Logins',
  'Last Login',
  'Created At',
  'Is Admin',
  'Is Banned',
];

export const exportUsersCsv = async (params: IGetUsersParams): Promise<void> => {
  // Deliberately not fetchUsers: that helper turns a failure into an empty result set, which here
  // would download a header-only file reading as "zero users". The rejection has to reach the
  // caller so it can say the export failed. Same reasoning as fetchCounterLogs in userAPICalls.
  const { data } = await api.get<IGetUsersResponse>('/api/users', {
    params: { ...params, downloadAll: true, page: 1, limit: 1000000 },
  });

  const rows = data.users.map(user => {
    const lastLogin = getLastLoginDate(user);

    return [
      user.name,
      // The populated org ref lives on organizationId; reading `user.organization` left this
      // column empty. Undefined (a blank cell) if the API returns a bare id instead of the doc.
      user.organizationId?.name,
      user.username,
      user.email,
      user.loginRecords?.length ?? 0,
      lastLogin ? lastLogin.toISOString() : 'N/A',
      user.createdAt,
      user.isAdmin ? 'Yes' : 'No',
      user.isBanned ? 'Yes' : 'No',
    ];
  });

  downloadData(toCsv([CSV_HEADERS, ...rows]), 'users.csv', 'text/csv;charset=utf-8;');
};
