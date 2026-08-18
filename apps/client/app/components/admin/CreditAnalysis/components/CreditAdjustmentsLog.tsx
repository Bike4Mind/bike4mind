import React, { useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import { formatCredits, numberCell } from '../utils/format';
import { useCreditAdjustmentsLog } from '../hooks/useCreditAdjustmentsLog';

const DAY_OPTIONS = [7, 30, 90, 365] as const;

const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Global, paginated audit trail of admin credit adjustments across all users
 * (the generic_add / generic_deduct rows adminUpdateUser writes). Newest first;
 * `days` narrows to a trailing window, "All time" removes it. Reads
 * /api/admin/credit-adjustments.
 */
export const CreditAdjustmentsLog: React.FC = () => {
  const [days, setDays] = useState<number | 'all'>(90);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  const { data, isLoading, isFetching, error, refetch } = useCreditAdjustmentsLog({
    page,
    limit,
    days: days === 'all' ? undefined : days,
  });

  const rows = data?.rows ?? [];

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="credit-adjustments-log">
      <Stack direction="row" justifyContent="flex-end" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Select<number | 'all'>
          size="sm"
          value={days}
          onChange={(_, v) => {
            setDays(v ?? 90);
            setPage(1);
          }}
          sx={{ minWidth: 120 }}
          data-testid="adjustments-days-select"
        >
          {DAY_OPTIONS.map(d => (
            <Option key={d} value={d}>
              {d}d
            </Option>
          ))}
          <Option value="all">All time</Option>
        </Select>
        <IconButton size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="adjustments-refresh-btn">
          <RefreshIcon />
        </IconButton>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        Manual admin credit adjustments across all users, newest first. Each row records who made the change, on whom,
        the delta, the resulting balance, and the reason.
      </Alert>

      {error && (
        <Alert color="danger" sx={{ mb: 2 }} data-testid="adjustments-error">
          {(error as Error)?.message || 'Failed to load adjustments'}
        </Alert>
      )}

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <Sheet sx={{ maxHeight: 520, overflow: 'auto', borderRadius: 'sm' }}>
            <Table stickyHeader hoverRow size="sm" data-testid="adjustments-table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>When</th>
                  <th>User</th>
                  <th>Admin</th>
                  <th>Reason</th>
                  <th style={{ textAlign: 'right', width: 100 }}>Delta</th>
                  <th style={{ textAlign: 'right', width: 100 }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const negative = r.credits < 0;
                  return (
                    <tr key={r.id}>
                      <td>{formatWhen(r.createdAt)}</td>
                      <td title={r.targetUserId}>{r.targetUserName ?? 'Unknown user'}</td>
                      <td title={r.actorId}>{r.actorName ?? (r.actorId ? 'Unknown admin' : '—')}</td>
                      <td>{r.description || '—'}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>
                        <Chip size="sm" variant="soft" color={negative ? 'danger' : 'success'}>
                          {negative ? '-' : '+'}
                          {formatCredits(Math.abs(r.credits))}
                        </Chip>
                      </td>
                      <td style={{ textAlign: 'right', ...numberCell }}>
                        {typeof r.resultingBalance === 'number' ? r.resultingBalance.toLocaleString() : '—'}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <Typography level="body-sm" color="neutral">
                        No admin credit adjustments recorded in this window.
                      </Typography>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Sheet>

          <SharedPaginationControls
            currentPage={data?.page ?? page}
            totalPages={data?.totalPages ?? 1}
            itemsPerPage={limit}
            totalItems={data?.total ?? 0}
            onPageChange={setPage}
            onItemsPerPageChange={size => {
              setLimit(size);
              setPage(1);
            }}
            pageLimitOptions={[25, 50, 100]}
          />
        </>
      )}
    </Box>
  );
};
