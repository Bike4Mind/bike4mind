import React, { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/joy';
import type { IAdminLegacyApiKeyRow } from '@bike4mind/common';
import { useAdminLegacyApiKeys } from '@client/app/hooks/data/adminLegacyApiKeys';
import {
  AdminPageHeader,
  DataTable,
  EmptyState,
  RelativeTime,
  SegmentedControl,
  StatStrip,
  StatTile,
  UpdatingBar,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const WINDOW_OPTIONS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;
type WindowValue = (typeof WINDOW_OPTIONS)[number]['value'];

const formatDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not set';

const columns: DataColumn<IAdminLegacyApiKeyRow>[] = [
  {
    id: 'owner',
    label: 'Owner',
    render: row => (
      <Stack sx={{ minWidth: 0 }}>
        <Typography level="body-sm" noWrap>
          {row.ownerEmail ?? '-'}
        </Typography>
        <Typography level="body-xs" sx={{ fontFamily: 'code', color: 'admin.inkMuted' }} noWrap>
          {row.userId}
        </Typography>
      </Stack>
    ),
  },
  { id: 'name', label: 'Key', render: row => row.name },
  {
    id: 'prefix',
    label: 'Prefix',
    width: '11rem',
    render: row => <Typography sx={{ fontFamily: 'code' }}>{row.keyPrefix}</Typography>,
  },
  { id: 'created', label: 'Created', width: '9rem', render: row => formatDate(row.createdAt) },
  { id: 'lastUsed', label: 'Last used', width: '9rem', render: row => <RelativeTime at={row.lastUsedAt} /> },
];

/**
 * Recently used legacy API keys and their owners: who still has to create a scoped key before
 * legacy access ends. Read-only; the legacy rule is decided server-side.
 */
const LegacyApiKeysTab: React.FC = () => {
  const [days, setDays] = useState<WindowValue>('30');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const { data, isPending, isError, isFetching, isPlaceholderData, refetch } = useAdminLegacyApiKeys({
    page,
    limit: pageSize,
    days: Number(days),
  });

  const total = data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (data && !isPlaceholderData && page > lastPage) setPage(lastPage);

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-legacy-api-keys-tab">
      <AdminPageHeader
        title="Legacy API keys"
        count={data ? total : undefined}
        description="Keys created before the scope cutoff still reach routes they hold no scope for, until legacy access ends. Owners listed here need a new scoped key before then. Sorted by last use, which changes as keys are used, so a key can move between pages while you browse."
      />

      <StatStrip aria-label="Legacy window">
        <StatTile label="Legacy keys in use" value={data ? total.toLocaleString() : '-'} />
        <StatTile label="Owners" value={data ? data.ownerCount.toLocaleString() : '-'} />
        <StatTile label="Cutoff" value={data ? formatDate(data.cutoff) : '-'} />
        <StatTile label="Legacy access ends" value={data ? formatDate(data.endsAt) : '-'} />
      </StatStrip>

      <Box>
        <SegmentedControl
          options={WINDOW_OPTIONS}
          value={days}
          onChange={value => {
            setDays(value);
            setPage(1);
          }}
          aria-label="Used within"
          data-testid="admin-legacy-api-keys-window"
        />
      </Box>

      <Box sx={{ position: 'relative' }}>
        <UpdatingBar active={isFetching && !isPending} placement="overlay" testId="admin-legacy-api-keys-updating" />
        <DataTable
          label="Legacy API keys"
          testId="admin-legacy-api-keys-table"
          rows={isPlaceholderData ? [] : (data?.rows ?? [])}
          columns={columns}
          getRowId={row => row.keyId}
          rowTestId={row => `admin-legacy-api-key-row-${row.keyId}`}
          loading={isPending || isPlaceholderData}
          error={isError && !data ? 'Legacy API keys could not be loaded.' : undefined}
          onRetry={() => void refetch()}
          pagination={{
            page,
            pageSize,
            total,
            onPageChange: setPage,
            onPageSizeChange: size => {
              setPageSize(size);
              setPage(1);
            },
          }}
          minWidth="48rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="No legacy keys in use"
              description={`No legacy key was used in the last ${days} days.`}
              action={
                <Button
                  variant="outlined"
                  onClick={() => void refetch()}
                  data-testid="admin-legacy-api-keys-refresh-btn"
                >
                  Refresh
                </Button>
              }
            />
          }
        />
      </Box>
    </Stack>
  );
};

export default LegacyApiKeysTab;
