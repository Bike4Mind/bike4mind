import type { SideAppsResponse, SideAppUsersResponse } from '@client/shared/sideApps';

const cell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  const safe = /^[\s]*[=+\-@]/.test(text) && typeof value === 'string' ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
};

const toCsv = (rows: (string | number | null)[][]): string => rows.map(row => row.map(cell).join(',')).join('\r\n');

export const sideAppsCsv = (data: SideAppsResponse): string =>
  toCsv([
    [
      'Client ID',
      'App',
      'Spend window days',
      'Request window days',
      'Credits',
      'Paying users',
      'Paid credits',
      'Unpaid credits',
      'Org credits',
      'Unrecorded credits',
      'Requests',
      'Completed',
      'Failed',
      'Interrupted',
      'Failure rate',
      'Refusals',
    ],
    ...data.apps.map(app => [
      app.clientId,
      app.name,
      data.spendWindowDays,
      data.requestWindowDays,
      app.spend.credits,
      app.spend.payingUsers,
      app.spend.byTier.paid,
      app.spend.byTier.unpaid,
      app.spend.byTier.org,
      app.spend.byTier.unrecorded,
      app.requests.total,
      app.outcomes.completed,
      app.outcomes.failed,
      app.outcomes.interrupted,
      app.outcomes.failureRate,
      app.refusals.total,
    ]),
  ]);

export const sideAppUsersCsv = (data: SideAppUsersResponse): string =>
  toCsv([
    [
      'User ID',
      'Name',
      'Email',
      'Current tier',
      'Credits',
      'Paid credits',
      'Unpaid credits',
      'Org credits',
      'Unrecorded credits',
      'Requests',
      'Failed requests',
      'Refusals',
      'Last used',
      'Top models',
    ],
    ...data.users.map(user => [
      user.userId,
      user.name,
      user.email,
      user.currentTier,
      user.credits,
      user.creditsByTier.paid,
      user.creditsByTier.unpaid,
      user.creditsByTier.org,
      user.creditsByTier.unrecorded,
      user.requests,
      user.failedRequests,
      user.refusals,
      user.lastUsedAt,
      user.topModels.map(model => `${model.model} (${model.credits})`).join('; '),
    ]),
  ]);

const download = (csv: string, filename: string): void => {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

export const downloadSideAppsCsv = (data: SideAppsResponse): void =>
  download(sideAppsCsv(data), `side-apps-${data.spendWindowDays}d.csv`);

export const downloadSideAppUsersCsv = (data: SideAppUsersResponse): void =>
  download(sideAppUsersCsv(data), `side-app-${data.clientId}-users-${data.spendWindowDays}d.csv`);
