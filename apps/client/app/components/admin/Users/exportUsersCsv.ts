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

/** Wraps values containing a comma/quote/newline so they survive a spreadsheet import. */
const escapeCell = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const exportUsersCsv = async (params: IGetUsersParams): Promise<void> => {
  const { users } = await fetchUsers({ ...params, downloadAll: true, page: 1, limit: 1000000 });

  const rows = users.map(user => [
    user.name,
    // The populated org ref lives on organizationId; the old `user.organization` read was
    // always undefined, so this column shipped empty. Reads as undefined (blank cell) if the
    // API ever returns a bare id string instead of the populated document.
    user.organizationId?.name,
    user.username,
    user.email,
    user.loginRecords?.length ?? 0,
    user.loginRecords?.length ? user.loginRecords[0].loginTime : 'N/A',
    user.createdAt,
    user.isAdmin ? 'Yes' : 'No',
    user.isBanned ? 'Yes' : 'No',
  ]);

  const csvData = [CSV_HEADERS, ...rows].map(row => row.map(escapeCell).join(',')).join('\n');

  const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', 'users.csv');
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
