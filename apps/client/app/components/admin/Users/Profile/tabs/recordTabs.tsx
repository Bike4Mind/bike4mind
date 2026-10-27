import React, { useMemo, useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { ApiKeyStatus, type AuditEntry, type ILoginRecord, type IUserApiKeyDocument } from '@bike4mind/common';
import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import { useUserActivity } from '@client/app/hooks/data/adminUserActivity';
import {
  useUserCreditAdjustments,
  type UserCreditAdjustment,
} from '@client/app/components/admin/CreditAnalysis/hooks/useUserCreditAdjustments';
import { AuditEntryDrawer } from '@client/app/components/admin/AuditLog/shared';
import { UserCreditBalanceChart } from '../../Activity/UserCreditBalanceChart';
import AdminGenerateApiKeyModal from '../../Details/AdminGenerateApiKeyModal';
import AdminApiKeysModal from '../../Details/AdminApiKeysModal';
import { DataTable, RelativeTime, SectionCard, StatusChip, type DataColumn } from '../../../shared';
import { formatCredits, formatCreditDelta } from '../actions/creditAdjustment';
import { AuditTimeline } from './AuditTimeline';
import type { AdminUserProfile } from '../userProfileModel';

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Typography level="body-sm" sx={{ p: 2, color: 'admin.inkMuted' }}>
    {children}
  </Typography>
);

const LEDGER_COLUMNS: readonly DataColumn<UserCreditAdjustment>[] = [
  { id: 'when', label: 'When', render: row => <RelativeTime at={row.createdAt} /> },
  {
    id: 'detail',
    label: 'Detail',
    render: row =>
      [row.reason ?? row.description, row.actorName && `by ${row.actorName}`].filter(Boolean).join(' \u00b7 '),
  },
  {
    id: 'change',
    label: 'Change',
    numeric: true,
    render: row => (
      <Box component="span" sx={{ color: row.credits > 0 ? 'admin.status.good.foreground' : 'admin.ink' }}>
        {formatCreditDelta(row.credits)}
      </Box>
    ),
  },
  {
    id: 'balance',
    label: 'Balance',
    numeric: true,
    render: row => (row.resultingBalance === undefined ? '-' : formatCredits(row.resultingBalance)),
  },
];

/** Balance over time plus the admin adjustment ledger; usage itself lives in the Activity tab. */
export const CreditsTab: React.FC<{ user: AdminUserProfile; onAdjust: () => void }> = ({ user, onAdjust }) => {
  const ledger = useUserCreditAdjustments(user.id);
  return (
    <Stack gap={2} data-testid="user-profile-credits">
      <SectionCard title="Balance" body="custom">
        <Box sx={{ p: 2 }}>
          <UserCreditBalanceChart userId={user.id} />
        </Box>
      </SectionCard>
      <SectionCard
        title="Admin adjustments"
        body="custom"
        action={
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            onClick={onAdjust}
            data-testid="user-profile-credits-adjust-btn"
          >
            Adjust credits
          </Button>
        }
      >
        <DataTable
          rows={ledger.data ?? []}
          columns={LEDGER_COLUMNS}
          getRowId={row => row.id}
          label="Admin credit adjustments"
          loading={ledger.isLoading}
          error={ledger.isError ? 'The ledger could not be loaded.' : undefined}
          onRetry={() => void ledger.refetch()}
          empty={<Empty>No admin adjustments yet.</Empty>}
          testId="user-profile-credit-ledger"
        />
      </SectionCard>
    </Stack>
  );
};

const KEY_STATUS: Readonly<Record<ApiKeyStatus, { label: string; tone: 'good' | 'neutral' | 'warn' | 'bad' }>> = {
  [ApiKeyStatus.ACTIVE]: { label: 'Active', tone: 'good' },
  [ApiKeyStatus.DISABLED]: { label: 'Revoked', tone: 'neutral' },
  [ApiKeyStatus.EXPIRED]: { label: 'Expired', tone: 'neutral' },
  [ApiKeyStatus.RATE_LIMITED]: { label: 'Rate limited', tone: 'warn' },
};

const KEY_COLUMNS: readonly DataColumn<IUserApiKeyDocument>[] = [
  { id: 'name', label: 'Name', render: key => key.name },
  {
    id: 'prefix',
    label: 'Prefix',
    render: key => (
      <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
        {key.keyPrefix}
      </Box>
    ),
  },
  { id: 'created', label: 'Created', render: key => <RelativeTime at={key.createdAt} /> },
  {
    id: 'lastUsed',
    label: 'Last used',
    render: key => (key.lastUsedAt ? <RelativeTime at={key.lastUsedAt} /> : 'Never'),
  },
  {
    id: 'status',
    label: 'Status',
    render: key => {
      const status = KEY_STATUS[key.status] ?? { label: key.status, tone: 'neutral' as const };
      return <StatusChip tone={status.tone} label={status.label} />;
    },
  },
];

export const ApiKeysTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const keys = useAdminGetUserApiKeys(user.id);
  const [modal, setModal] = useState<'generate' | 'limits' | null>(null);
  return (
    <>
      <SectionCard
        title="API keys"
        body="custom"
        action={
          <Stack direction="row" gap={1}>
            <Button
              size="sm"
              variant="plain"
              color="neutral"
              onClick={() => setModal('limits')}
              data-testid="user-profile-key-limits-btn"
            >
              Rate limits
            </Button>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={() => setModal('generate')}
              data-testid="user-profile-generate-key-btn"
            >
              Generate key
            </Button>
          </Stack>
        }
        data-testid="user-profile-api-keys"
      >
        <DataTable
          rows={keys.data?.apiKeys ?? []}
          columns={KEY_COLUMNS}
          getRowId={key => key.id}
          label="API keys"
          loading={keys.isLoading}
          error={keys.isError ? 'API keys could not be loaded.' : undefined}
          onRetry={() => void keys.refetch()}
          empty={<Empty>This user has no API keys.</Empty>}
          testId="user-profile-api-key-table"
        />
      </SectionCard>
      <AdminGenerateApiKeyModal open={modal === 'generate'} onClose={() => setModal(null)} user={user} />
      <AdminApiKeysModal open={modal === 'limits'} onClose={() => setModal(null)} user={user} />
    </>
  );
};

type SignInRow = ILoginRecord & { id: string };

const SIGN_IN_COLUMNS: readonly DataColumn<SignInRow>[] = [
  { id: 'when', label: 'When', render: row => <RelativeTime at={row.loginTime} /> },
  { id: 'location', label: 'Location', render: row => row.location || '-' },
  {
    id: 'device',
    label: 'Device',
    render: row => [row.browser, row.operatingSystem].filter(Boolean).join(' on ') || '-',
  },
  { id: 'type', label: 'Type', render: row => row.deviceType || '-' },
  {
    id: 'ip',
    label: 'IP address',
    render: row => (
      <Box component="span" sx={{ fontFamily: 'code', fontSize: 12 }}>
        {row.ip || '-'}
      </Box>
    ),
  },
];

/** Successful sign-ins recorded on the user; blocked attempts live in the security events of Activity. */
export const SignInsTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const rows = useMemo<SignInRow[]>(
    () =>
      [...(user.loginRecords ?? [])]
        .sort((a, b) => new Date(b.loginTime).getTime() - new Date(a.loginTime).getTime())
        .map((record, index) => ({ ...record, id: `${new Date(record.loginTime).getTime()}-${index}` })),
    [user.loginRecords]
  );
  return (
    <SectionCard
      title="Sign-ins"
      body="custom"
      action={
        <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
          Successful sign-ins
        </Typography>
      }
      data-testid="user-profile-sign-ins"
    >
      <DataTable
        rows={rows}
        columns={SIGN_IN_COLUMNS}
        getRowId={row => row.id}
        label="Sign-ins"
        onRetry={() => undefined}
        empty={<Empty>No sign-ins recorded.</Empty>}
        testId="user-profile-sign-in-table"
      />
    </SectionCard>
  );
};

/** Admin-made changes to this account, newest first; a row opens the full audit entry. */
export const AdminLogTab: React.FC<{ user: AdminUserProfile }> = ({ user }) => {
  const activity = useUserActivity(user.id, { direction: 'target', includeSecurity: false });
  const [selected, setSelected] = useState<AuditEntry | null>(null);
  const entries = useMemo(
    () => activity.data?.pages.flatMap(page => page.entries).filter(entry => entry.source === 'admin') ?? [],
    [activity.data]
  );

  const body = () => {
    if (activity.isLoading) return <Empty>Loading...</Empty>;
    if (activity.isError) return <Empty>The admin log could not be loaded.</Empty>;
    if (entries.length === 0) return <Empty>No admin has changed this account yet.</Empty>;
    return <AuditTimeline entries={entries} onSelect={setSelected} data-testid="user-profile-admin-log-list" />;
  };

  return (
    <>
      <SectionCard title="Admin actions on this account" body="custom" data-testid="user-profile-admin-log">
        {body()}
        {activity.hasNextPage && (
          <Box sx={{ p: 2, borderTop: '1px solid', borderColor: 'admin.border' }}>
            <Button
              size="sm"
              variant="outlined"
              color="neutral"
              loading={activity.isFetchingNextPage}
              onClick={() => void activity.fetchNextPage()}
              data-testid="user-profile-admin-log-more-btn"
            >
              Load more
            </Button>
          </Box>
        )}
      </SectionCard>
      <AuditEntryDrawer entry={selected} onClose={() => setSelected(null)} />
    </>
  );
};
