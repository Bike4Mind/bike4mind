import { api } from '@client/app/contexts/ApiContext';
import type { AdminUsersFilter } from '@client/app/utils/adminUsersFilter';
import { toCsv } from '@client/app/utils/csv';
import { downloadData } from '@client/app/utils/download';

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

/** One row of GET /api/admin/users/export (exportAdminUsers), as JSON. */
type ExportedUser = {
  name?: string;
  username?: string;
  email?: string;
  organizationName: string | null;
  loginCount: number;
  lastLoginAt: string | null;
  createdAt?: string;
  isAdmin?: boolean;
  isBanned?: boolean;
};

/**
 * Downloads every user the filter matches as CSV. Resolves with whether the server stopped at its
 * row ceiling, so the caller can say the file is partial. A failed request rejects and writes no
 * file: a header-only CSV would read as a successful export of zero users.
 */
export const exportUsersCsv = async (filter: AdminUsersFilter): Promise<{ truncated: boolean }> => {
  const { data } = await api.get<{ users: ExportedUser[]; truncated: boolean }>('/api/admin/users/export', {
    params: filter,
  });
  const rows = data.users.map(user => [
    user.name,
    user.organizationName ?? undefined,
    user.username,
    user.email,
    user.loginCount,
    user.lastLoginAt ? new Date(user.lastLoginAt).toISOString() : 'N/A',
    user.createdAt,
    user.isAdmin ? 'Yes' : 'No',
    user.isBanned ? 'Yes' : 'No',
  ]);
  downloadData(toCsv([CSV_HEADERS, ...rows]), 'users.csv', 'text/csv;charset=utf-8;');
  return { truncated: data.truncated };
};
