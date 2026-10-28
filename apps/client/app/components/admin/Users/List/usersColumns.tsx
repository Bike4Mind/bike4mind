import { Box, Stack, Typography } from '@mui/joy';
import {
  NEW_ACCOUNT_WINDOW_MS,
  RISK_BAND,
  type AdminUsersListRow,
  type AdminUsersSortField,
} from '@client/app/utils/adminUsersFilter';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { InitialsAvatar } from '../../shared/InitialsAvatar';
import { InlineBar } from '../../shared/InlineBar';
import { StatusChip } from '../../shared/StatusChip';
import type { DataColumn } from '../../shared/DataTable';
import { formatAccountAge, formatAccountCreatedTitle, formatLastActiveTitle } from '../formatAccountAge';

export const PLAN_LABELS: Record<string, string> = {
  DemoUser: 'Demo',
  PaidUser: 'Paid',
  VIPUser: 'VIP',
  ManagerUser: 'Manager',
  AdminUser: 'Admin',
};

export const SIGNUP_METHOD_LABELS: Record<string, string> = {
  email: 'Email',
  google: 'Google',
  github: 'GitHub',
  facebook: 'Facebook',
  okta: 'Okta',
  saml: 'SAML',
};

type AccountStatus = { label: string; tone: AdminStatusTone };

/** Suspended outranks Restricted, which outranks New (under a week old); everyone else is Active. */
export function accountStatus(
  row: Pick<AdminUsersListRow, 'isBanned' | 'isModerated' | 'createdAt'>,
  now: Date
): AccountStatus {
  if (row.isBanned) return { label: 'Suspended', tone: 'bad' };
  if (row.isModerated) return { label: 'Restricted', tone: 'warn' };
  const created = row.createdAt ? new Date(row.createdAt).getTime() : Number.NaN;
  if (now.getTime() - created < NEW_ACCOUNT_WINDOW_MS) return { label: 'New', tone: 'info' };
  return { label: 'Active', tone: 'good' };
}

const RISK_BY_BAND: Record<string, AccountStatus> = {
  [RISK_BAND.high]: { label: 'High', tone: 'bad' },
  [RISK_BAND.medium]: { label: 'Medium', tone: 'warn' },
  [RISK_BAND.low]: { label: 'Low', tone: 'neutral' },
};

/** Risk from the signup assessment band; undefined when the account was never assessed. */
export const accountRisk = (row: Pick<AdminUsersListRow, 'signupGrantAssessment'>): AccountStatus | undefined =>
  RISK_BY_BAND[row.signupGrantAssessment?.band ?? ''];

const Dash = () => (
  <Typography component="span" sx={{ color: 'admin.inkMuted' }} aria-label="None">
    {'\u2014'}
  </Typography>
);

const Muted = ({ children, title }: { children: string; title?: string }) => (
  <Typography level="body-sm" component="span" title={title} sx={{ color: 'admin.inkMuted', whiteSpace: 'nowrap' }}>
    {children}
  </Typography>
);

const formatNumber = (value: number) => Math.round(value).toLocaleString();

/** Columns sortable on the server map to these fields. */
export const USERS_SORT_COLUMNS: Record<string, AdminUsersSortField> = {
  user: 'name',
  signedUp: 'createdAt',
  lastActive: 'lastActiveAt',
  credits: 'currentCredits',
};

export function usersColumns({ now, maxSpend }: { now: Date; maxSpend: number }): DataColumn<AdminUsersListRow>[] {
  return [
    {
      id: 'user',
      label: 'User',
      sortable: true,
      width: '13rem',
      render: row => (
        <Stack direction="row" alignItems="center" gap={1.25} sx={{ minWidth: 0 }}>
          <InitialsAvatar
            name={row.name}
            fallback={row.email ?? row.username ?? ''}
            seed={row.id}
            src={row.photoUrl ?? undefined}
          />
          <Box sx={{ minWidth: 0 }}>
            <Typography
              level="body-sm"
              noWrap
              sx={{ color: 'admin.ink', fontWeight: 600, fontSize: 13 }}
              data-testid={`admin-users-name-${row.id}`}
            >
              {row.name || row.username || row.email}
            </Typography>
            <Typography noWrap sx={{ color: 'admin.inkMuted', fontSize: 12 }}>
              {row.email}
            </Typography>
          </Box>
        </Stack>
      ),
    },
    {
      id: 'status',
      label: 'Status',
      width: '7.5rem',
      render: row => {
        const status = accountStatus(row, now);
        return <StatusChip dot tone={status.tone} label={status.label} data-testid={`admin-users-status-${row.id}`} />;
      },
    },
    {
      id: 'plan',
      label: 'Plan',
      width: '5rem',
      render: row => (
        <Typography level="body-sm" sx={{ color: 'admin.inkSecondary' }}>
          {PLAN_LABELS[row.level] ?? row.level}
        </Typography>
      ),
    },
    {
      id: 'signedUp',
      label: 'Signed up',
      sortable: true,
      width: '8rem',
      render: row => (
        <Muted title={formatAccountCreatedTitle(row.createdAt) ?? undefined}>
          {`${formatAccountAge(row.createdAt, now) ?? '\u2014'} \u00b7 ${SIGNUP_METHOD_LABELS[row.signupMethod] ?? row.signupMethod}`}
        </Muted>
      ),
    },
    {
      id: 'lastActive',
      label: 'Last active',
      sortable: true,
      width: '7rem',
      render: row => {
        const age = formatAccountAge(row.lastActiveAt, now);
        return age ? <Muted title={formatLastActiveTitle(row.lastActiveAt) ?? undefined}>{age}</Muted> : <Dash />;
      },
    },
    {
      id: 'credits',
      label: 'Credits',
      sortable: true,
      numeric: true,
      width: '6rem',
      render: row => formatNumber(row.currentCredits ?? 0),
    },
    {
      id: 'spend',
      label: '30d spend',
      numeric: true,
      width: '7rem',
      render: row =>
        row.spend30d === null ? (
          <Dash />
        ) : (
          <Stack direction="row" alignItems="center" justifyContent="flex-end" gap={1}>
            <span>{formatNumber(row.spend30d)}</span>
            <InlineBar value={row.spend30d} max={maxSpend} />
          </Stack>
        ),
    },
    {
      id: 'apiKeys',
      label: 'API keys',
      numeric: true,
      width: '5rem',
      render: row => (row.apiKeyCount > 0 ? row.apiKeyCount.toLocaleString() : <Dash />),
    },
    {
      id: 'risk',
      label: 'Risk',
      width: '5.5rem',
      render: row => {
        const risk = accountRisk(row);
        return risk ? (
          <StatusChip tone={risk.tone} label={risk.label} data-testid={`admin-users-risk-${row.id}`} />
        ) : (
          <Dash />
        );
      },
    },
  ];
}
