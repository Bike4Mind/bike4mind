import React, { useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Option,
  Select,
  Sheet,
  Stack,
  Table,
  Tooltip,
  Typography,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useNavigate } from '@tanstack/react-router';
import {
  COMPLETION_SOURCES,
  CREDIT_ADD_TRANSACTION_TYPES,
  CREDIT_DEDUCT_TRANSACTION_TYPES,
  CreditTransactionType,
} from '@bike4mind/common';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import { formatCredits, numberCell } from '../utils/format';
import { useTransactionLedger, LedgerFilters } from '../hooks/useTransactionLedger';

const DAY_OPTIONS = [7, 30, 90, 365] as const;
const DEDUCT_TYPES = new Set<CreditTransactionType>(CREDIT_DEDUCT_TRANSACTION_TYPES);
const ALL_TYPES: CreditTransactionType[] = [...CREDIT_ADD_TRANSACTION_TYPES, ...CREDIT_DEDUCT_TRANSACTION_TYPES];

const labelFor = (t: string) => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type OrgOption = { id: string; name: string };

/**
 * Admin transaction-ledger: an organization's paginated, filterable credit
 * ledger (date / type / source / model) with drill-down to the session that
 * generated a charge. Reads CreditTransactionModel via /api/admin/transactions.
 * Member is shown only where the write path recorded it (API/CLI org-billed rows).
 */
export const TransactionLedger: React.FC = () => {
  const navigate = useNavigate();
  const [selectedOrg, setSelectedOrg] = useState<OrgOption | null>(null);
  const [filters, setFilters] = useState<LedgerFilters>({ days: 30, type: 'all', source: 'all' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

  const { debouncedValue: orgSearch, setValue: setOrgSearch } = useDebounceValue('', 500);
  const { data: orgResult, isLoading: orgsLoading } = useSearchOrganizations({
    page: 1,
    limit: 20,
    search: orgSearch,
    filters: { personal: false },
    orderBy: { by: 'name', direction: 'asc' },
  });
  const orgOptions: OrgOption[] = useMemo(
    () => (orgResult?.data ?? []).map(o => ({ id: String(o.id), name: o.name })),
    [orgResult]
  );

  const { data, isLoading, isFetching, error, refetch } = useTransactionLedger(
    selectedOrg?.id ?? null,
    filters,
    page,
    limit
  );

  // Any filter change invalidates the current page offset.
  const patchFilters = (patch: Partial<LedgerFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }));
    setPage(1);
  };

  const rows = data?.rows ?? [];

  return (
    <Box sx={{ p: { xs: 1, sm: 2 } }} data-testid="transaction-ledger">
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', md: 'center' }}
        spacing={1}
        sx={{ mb: 1 }}
      >
        <Autocomplete
          placeholder="Select an organization"
          options={orgOptions}
          getOptionLabel={o => o.name}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          value={selectedOrg}
          onChange={(_, value) => {
            setSelectedOrg(value);
            setPage(1);
          }}
          onInputChange={(_, value) => setOrgSearch(value)}
          loading={orgsLoading}
          sx={{ minWidth: 240 }}
          data-testid="ledger-org-select"
        />
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Select
            size="sm"
            value={filters.days ?? 30}
            onChange={(_, v) => patchFilters({ days: (v as number) ?? 30 })}
            data-testid="ledger-days-select"
          >
            {DAY_OPTIONS.map(d => (
              <Option key={d} value={d}>
                {d}d
              </Option>
            ))}
          </Select>
          <Select
            size="sm"
            value={filters.type ?? 'all'}
            onChange={(_, v) => patchFilters({ type: (v as LedgerFilters['type']) ?? 'all' })}
            sx={{ minWidth: 150 }}
            data-testid="ledger-type-select"
          >
            <Option value="all">All types</Option>
            {ALL_TYPES.map(t => (
              <Option key={t} value={t}>
                {labelFor(t)}
              </Option>
            ))}
          </Select>
          <Select
            size="sm"
            value={filters.source ?? 'all'}
            onChange={(_, v) => patchFilters({ source: (v as LedgerFilters['source']) ?? 'all' })}
            data-testid="ledger-source-select"
          >
            <Option value="all">All sources</Option>
            {COMPLETION_SOURCES.map(s => (
              <Option key={s} value={s}>
                {s}
              </Option>
            ))}
          </Select>
          <IconButton
            size="sm"
            onClick={() => refetch()}
            disabled={!selectedOrg || isFetching}
            data-testid="ledger-refresh-btn"
          >
            <RefreshIcon />
          </IconButton>
        </Stack>
      </Stack>

      <Alert color="neutral" size="sm" sx={{ mb: 2 }}>
        The organization&apos;s credit ledger (spend billed to its pool), newest first. Member is shown where the call
        recorded it (API/CLI org-billed rows); web org-billed usage does not carry a member on the transaction.
      </Alert>

      {error && (
        <Alert color="danger" sx={{ mb: 2 }} data-testid="ledger-error">
          {(error as Error)?.message || 'Failed to load ledger'}
        </Alert>
      )}

      {!selectedOrg ? (
        <Box sx={{ p: 4, textAlign: 'center' }}>
          <Typography level="body-sm" color="neutral">
            Select an organization to see its transaction ledger.
          </Typography>
        </Box>
      ) : isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          <Sheet sx={{ maxHeight: 520, overflow: 'auto', borderRadius: 'sm' }}>
            <Table stickyHeader hoverRow size="sm" data-testid="ledger-table">
              <thead>
                <tr>
                  <th style={{ width: 120 }}>When</th>
                  <th>Type</th>
                  <th>Source</th>
                  <th>Model</th>
                  <th>Member</th>
                  <th style={{ textAlign: 'right', width: 110 }}>Credits</th>
                  <th style={{ width: 48 }} aria-label="drill-down" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const isDeduct = DEDUCT_TYPES.has(r.type);
                  return (
                    <tr key={r.id}>
                      <td>{formatWhen(r.createdAt)}</td>
                      <td>{labelFor(r.type)}</td>
                      <td>{r.source ?? '—'}</td>
                      <td title={r.model}>{r.model ?? '—'}</td>
                      <td title={r.actingUserId}>{r.actingUserName ?? (r.actingUserId ? 'Unknown user' : '—')}</td>
                      <td style={{ textAlign: 'right', ...numberCell }}>
                        <Chip size="sm" variant="soft" color={isDeduct ? 'danger' : 'success'}>
                          {isDeduct ? '-' : '+'}
                          {formatCredits(Math.abs(r.credits))}
                        </Chip>
                      </td>
                      <td>
                        {r.sessionId && (
                          <Tooltip title="Open session">
                            <IconButton
                              size="sm"
                              variant="plain"
                              data-testid="ledger-drilldown-btn"
                              onClick={() => navigate({ to: '/notebooks/$id', params: { id: r.sessionId! } })}
                            >
                              <OpenInNewIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <Typography level="body-sm" color="neutral">
                        No transactions match these filters.
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
