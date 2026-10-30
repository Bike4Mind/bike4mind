import React, { useEffect, useState } from 'react';
import { Box, Button, Link, Stack } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { adminAuditLogPath } from '@bike4mind/common';
import { AdminPageHeader, DataTable, FilterBar } from '../../shared';
import { formatCredits } from '../utils/format';
import { useCreditAdjustmentsLog } from '../hooks/useCreditAdjustmentsLog';

const DAY_OPTIONS = [7, 30, 90, 365] as const;

export const CreditAdjustmentsLog: React.FC = () => {
  const [days, setDays] = useState('90');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const navigate = useNavigate();
  const { data, isLoading, isFetching, error, refetch } = useCreditAdjustmentsLog({
    page,
    limit,
    days: days === 'all' ? undefined : Number(days),
  });
  useEffect(() => {
    if (!isFetching && data && page > Math.max(1, data.totalPages)) setPage(Math.max(1, data.totalPages));
  }, [data, isFetching, page]);

  return (
    <Stack gap={2} data-testid="credit-adjustments-log">
      <AdminPageHeader
        title="Credit adjustments"
        count={data?.total}
        description="Manual credit changes across all users, newest first. Each row records the actor, delta, resulting balance and reason."
        actions={
          <Link
            component="button"
            onClick={() => {
              const search = Object.fromEntries(
                new URL(adminAuditLogPath({ category: 'credits' }), 'http://local').searchParams
              );
              void navigate({ to: '/admin', search: search as never });
            }}
            data-testid="credit-adjustments-audit-log-link"
          >
            View in Audit Log
          </Link>
        }
      />
      <FilterBar
        state={{ query: '', view: '', filters: { days } }}
        search={false}
        filters={[
          {
            id: 'days',
            label: 'Window',
            options: [
              ...DAY_OPTIONS.map(value => ({ value: String(value), label: `${value} days` })),
              { value: 'all', label: 'All time' },
            ],
          },
        ]}
        onChange={patch => {
          if (patch.filters) {
            setDays(patch.filters.days || 'all');
            setPage(1);
          }
        }}
      />
      <Box>
        <Button
          variant="plain"
          disabled={isFetching}
          onClick={() => void refetch()}
          data-testid="adjustments-refresh-btn"
        >
          Refresh adjustments
        </Button>
      </Box>
      <DataTable
        label="Credit adjustments"
        testId="adjustments-table"
        rows={data?.rows ?? []}
        getRowId={row => row.id}
        loading={isLoading || isFetching}
        error={error ? (error instanceof Error ? error.message : 'Could not load credit adjustments.') : undefined}
        onRetry={() => void refetch()}
        pagination={{
          page,
          pageSize: limit,
          total: data?.total ?? 0,
          onPageChange: next => {
            setPage(next);
          },
          onPageSizeChange: size => {
            setLimit(size);
            setPage(1);
          },
        }}
        columns={[
          { id: 'when', label: 'When', render: row => new Date(row.createdAt).toLocaleString() },
          {
            id: 'user',
            label: 'User',
            render: row => <span title={row.targetUserId}>{row.targetUserName ?? 'Unknown user'}</span>,
          },
          {
            id: 'admin',
            label: 'Admin',
            render: row => <span title={row.actorId}>{row.actorName ?? (row.actorId ? 'Unknown admin' : '-')}</span>,
          },
          { id: 'reason', label: 'Reason', render: row => row.description || '-' },
          {
            id: 'delta',
            label: 'Delta',
            numeric: true,
            render: row => `${row.credits < 0 ? '-' : '+'}${formatCredits(Math.abs(row.credits))}`,
          },
          {
            id: 'balance',
            label: 'Balance',
            numeric: true,
            render: row => (typeof row.resultingBalance === 'number' ? row.resultingBalance.toLocaleString() : '-'),
          },
        ]}
      />
    </Stack>
  );
};
