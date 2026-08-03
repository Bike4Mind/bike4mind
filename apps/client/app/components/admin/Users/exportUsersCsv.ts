import { IGetUsersParams, fetchUsers } from '@client/app/utils/userAPICalls';

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
  const { users } = await fetchUsers({ ...params, downloadAll: true, page: 1, limit: 1000000 });

  const rows = users.map(
    // any: the row shape is looser than IUserDocument here; kept as-is from the original
    // inline implementation so this extraction changes no output.
    (user: {
      name: any;
      organization?: { name: string };
      username: any;
      email: any;
      loginRecords: any;
      createdAt: any;
      isAdmin: any;
      isBanned: any;
    }) => [
      user.name,
      user.organization?.name,
      user.username,
      user.email,
      user.loginRecords.length,
      user.loginRecords?.length > 0 ? user.loginRecords[0].loginTime : 'N/A',
      user.createdAt,
      user.isAdmin ? 'Yes' : 'No',
      user.isBanned ? 'Yes' : 'No',
    ]
  );

  const csvData = [CSV_HEADERS, ...rows].map(row => row.join(',')).join('\n');

  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', 'users.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
