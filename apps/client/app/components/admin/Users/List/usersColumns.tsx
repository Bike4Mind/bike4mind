import { Box, Skeleton, Stack, Tooltip, Typography } from '@mui/joy';
import {
  NEW_ACCOUNT_WINDOW_MS,
  RISK_BAND,
  type AdminUsersListRow,
  type AdminUsersSortField,
} from '@client/app/utils/adminUsersFilter';
import {
  SIGNUP_SIGNAL_LABELS,
  SIGNUP_TIMESERIES_RANGE_LABELS as RANGE_LABELS,
  type SignupTimeseriesRange,
  type SignupVerdict,
  type SignupVerdicts,
} from '@client/app/utils/signupSignals';
import type { AdminStatusTone } from '@client/app/utils/themes/admin';
import { adminFocus } from '../../shared/adminStyles';
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

/** Chip and hover text for the signup chart's verdict; undefined when there is none to show. */
export function signupVerdictDisplay(
  verdict: SignupVerdict | null | undefined,
  range: SignupTimeseriesRange
): (AccountStatus & { title: string }) | undefined {
  if (!verdict) return undefined;
  const reasons = verdict.signals.map(signal => SIGNUP_SIGNAL_LABELS[signal].label).join(', ');
  const scope = `Signup chart, ${RANGE_LABELS[range].toLowerCase()}`;
  if (verdict.suspected) return { label: 'Suspected', tone: 'warn', title: `${scope}: ${reasons}.` };
  return {
    label: 'Likely legit',
    tone: 'neutral',
    title: reasons ? `${scope}: one weak signal, ${reasons}.` : `${scope}: no suspected-signup signals.`,
  };
}

export type UsersVerdictColumn = {
  range: SignupTimeseriesRange;
  /** Undefined while loading or after a failed fetch (the tab shows an alert for that). */
  verdicts?: SignupVerdicts['verdicts'];
  loading?: boolean;
};

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

export function usersColumns({
  now,
  maxSpend,
  verdict,
}: {
  now: Date;
  maxSpend: number;
  verdict: UsersVerdictColumn;
}): DataColumn<AdminUsersListRow>[] {
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
    {
      id: 'verdict',
      label: 'Verdict',
      width: '7rem',
      render: row => {
        if (verdict.loading) {
          return (
            <Skeleton
              variant="rectangular"
              width={64}
              height={22}
              sx={{ borderRadius: 'md' }}
              data-testid={`admin-users-verdict-loading-${row.id}`}
            />
          );
        }
        const shown = signupVerdictDisplay(verdict.verdicts?.[row.id], verdict.range);
        if (!shown) return <Dash />;
        return (
          <Tooltip title={shown.title} placement="top" enterTouchDelay={0}>
            {/* Focusable so keyboard and touch users can reach the reasons, not just mouse hover. */}
            <Box
              component="span"
              tabIndex={0}
              // A generic span may not carry aria-label; img makes it a labelled, non-interactive status.
              role="img"
              aria-label={`${shown.label}. ${shown.title}`}
              onClick={event => event.stopPropagation()}
              sx={{ display: 'inline-flex', borderRadius: 'md', ...adminFocus }}
            >
              <StatusChip tone={shown.tone} label={shown.label} data-testid={`admin-users-verdict-${row.id}`} />
            </Box>
          </Tooltip>
        );
      },
    },
  ];
}
