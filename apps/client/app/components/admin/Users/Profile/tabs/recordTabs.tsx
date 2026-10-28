import React, { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import { ApiKeyStatus, type IUserApiKeyDocument } from '@bike4mind/common';
import { useAdminGetUserApiKeys } from '@client/app/hooks/data/userApiKeys';
import {
  useUserCreditAdjustments,
  type UserCreditAdjustment,
} from '@client/app/components/admin/CreditAnalysis/hooks/useUserCreditAdjustments';
import { UserCreditBalanceChart } from '../../Activity/UserCreditBalanceChart';
import AdminGenerateApiKeyModal from '../../Details/AdminGenerateApiKeyModal';
import AdminApiKeysModal from '../../Details/AdminApiKeysModal';
import { DataTable, RelativeTime, SectionCard, StatusChip, type DataColumn } from '../../../shared';
import { formatCredits, formatCreditDelta } from '../actions/creditAdjustment';
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
