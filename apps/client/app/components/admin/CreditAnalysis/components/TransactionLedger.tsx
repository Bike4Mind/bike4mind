import React, { useEffect, useMemo, useState } from 'react';
import { Autocomplete, Button, Chip, Stack, Tooltip } from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import {
  COMPLETION_SOURCES,
  CREDIT_ADD_TRANSACTION_TYPES,
  CREDIT_DEDUCT_TRANSACTION_TYPES,
  CreditTransactionType,
} from '@bike4mind/common';
import { useSearchOrganizations } from '@client/app/hooks/data/organizations';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import { AdminPageHeader, DataTable, EmptyState, ErrorState, FilterBar } from '../../shared';
import { formatCredits } from '../utils/format';
import { useTransactionLedger, LedgerFilters } from '../hooks/useTransactionLedger';
import { SessionUsageDetailModal } from './SessionUsageDetailModal';

const DAY_OPTIONS = [7, 30, 90, 365] as const;
const ALL_TYPES: CreditTransactionType[] = [...CREDIT_ADD_TRANSACTION_TYPES, ...CREDIT_DEDUCT_TRANSACTION_TYPES];

const labelFor = (t: string) => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const formatWhen = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

type OrgOption = { id: string; name: string };

/**
 * An organization's paginated, filterable credit ledger (date / type / source /
 * model) with drill-down to the session that generated a charge. Reads
 * CreditTransactionModel via /api/admin/transactions. Member is shown only where
 * the write path recorded it (API/CLI org-billed rows).
 *
 * With `organizationId` the org is fixed and the picker is hidden - this is the
 * org owner/manager surface (their org only). Without it, an admin picks any org.
 */
export const TransactionLedger: React.FC<{ organizationId?: string }> = ({ organizationId: fixedOrgId }) => {
  const [selectedOrg, setSelectedOrg] = useState<OrgOption | null>(null);
  const [filters, setFilters] = useState<LedgerFilters>({ days: 30, type: 'all', source: 'all' });
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [detailSessionId, setDetailSessionId] = useState<string | null>(null);

  const activeOrgId = fixedOrgId ?? selectedOrg?.id ?? null;

  const { debouncedValue: orgSearch, setValue: setOrgSearch } = useDebounceValue('', 500);
  // Skipped in fixed-org mode - the picker is hidden and non-admins can't list orgs.
  const {
    data: orgResult,
    isLoading: orgsLoading,
    isError: orgsError,
    isFetching: orgsFetching,
    refetch: refetchOrganizations,
  } = useSearchOrganizations(
    {
      page: 1,
      limit: 20,
      search: orgSearch,
      filters: { personal: false },
      orderBy: { by: 'name', direction: 'asc' },
    },
    { enabled: !fixedOrgId }
  );
  const orgOptions: OrgOption[] = useMemo(
    () => (orgResult?.data ?? []).map(o => ({ id: String(o.id), name: o.name })),
    [orgResult]
  );

  const { data, isLoading, isFetching, error, refetch } = useTransactionLedger(activeOrgId, filters, page, limit);
  useEffect(() => {
    if (!isFetching && data && page > Math.max(1, data.totalPages)) setPage(Math.max(1, data.totalPages));
  }, [data, isFetching, page]);

  // Any filter change invalidates the current page offset.
  const patchFilters = (patch: Partial<LedgerFilters>) => {
    setFilters(prev => ({ ...prev, ...patch }));
    setPage(1);
  };

  return (
    <Stack gap={2} data-testid="transaction-ledger">
      <AdminPageHeader
        level="section"
        title="Transaction ledger"
        count={activeOrgId ? data?.total : undefined}
        description="Spend billed to the organization's credit pool, newest first. Member appears where the call recorded it."
        actions={
          <Button
            variant="plain"
            onClick={() => void refetch()}
            disabled={!activeOrgId || isFetching}
            data-testid="ledger-refresh-btn"
            startDecorator={<RefreshIcon />}
          >
            Refresh ledger
          </Button>
        }
      />
      {!fixedOrgId && orgsError && (
        <ErrorState
          message="Organizations could not be loaded."
          onRetry={() => void refetchOrganizations()}
          retrying={orgsFetching}
        />
      )}
      {!fixedOrgId && (
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
      )}
      <FilterBar
        search={false}
        state={{
          query: '',
          view: '',
          filters: { days: String(filters.days ?? 30), type: filters.type ?? 'all', source: filters.source ?? 'all' },
        }}
        filters={[
          {
            id: 'days',
            label: 'Window',
            options: DAY_OPTIONS.map(value => ({ value: String(value), label: `${value} days` })),
          },
          {
            id: 'type',
            label: 'Type',
            options: [
              { value: 'all', label: 'All types' },
              ...ALL_TYPES.map(value => ({ value, label: labelFor(value) })),
            ],
          },
          {
            id: 'source',
            label: 'Source',
            options: [
              { value: 'all', label: 'All sources' },
              ...COMPLETION_SOURCES.map(value => ({ value, label: value })),
            ],
          },
        ]}
        onChange={patch => {
          if (!patch.filters) return;
          patchFilters({
            days: Number(patch.filters.days || 30),
            type: (patch.filters.type || 'all') as LedgerFilters['type'],
            source: (patch.filters.source || 'all') as LedgerFilters['source'],
          });
        }}
      />
      {!activeOrgId ? (
        <EmptyState title="Select an organization to see its transaction ledger" action={null} />
      ) : (
        <DataTable
          label="Transaction ledger"
          testId="ledger-table"
          rows={data?.rows ?? []}
          getRowId={row => row.id}
          loading={isLoading || isFetching}
          error={error ? (error instanceof Error ? error.message : 'Failed to load ledger') : undefined}
          onRetry={() => void refetch()}
          pagination={{
            page,
            pageSize: limit,
            total: data?.total ?? 0,
            onPageChange: setPage,
            onPageSizeChange: size => {
              setLimit(size);
              setPage(1);
            },
          }}
          maxHeight="520px"
          columns={[
            { id: 'when', label: 'When', render: row => formatWhen(row.createdAt) },
            { id: 'type', label: 'Type', render: row => labelFor(row.type) },
            { id: 'source', label: 'Source', render: row => row.source ?? '-' },
            { id: 'model', label: 'Model', render: row => <span title={row.model}>{row.model ?? '-'}</span> },
            {
              id: 'member',
              label: 'Member',
              render: row => (
                <span title={row.actingUserId}>{row.actingUserName ?? (row.actingUserId ? 'Unknown user' : '-')}</span>
              ),
            },
            {
              id: 'credits',
              label: 'Credits',
              numeric: true,
              render: row => (
                <Chip size="sm" variant="soft" color={row.credits < 0 ? 'danger' : 'success'}>
                  {row.credits < 0 ? '-' : '+'}
                  {formatCredits(Math.abs(row.credits))}
                </Chip>
              ),
            },
          ]}
          rowActions={row =>
            row.sessionId ? (
              <Tooltip title="Session usage detail">
                <Button
                  size="sm"
                  variant="plain"
                  data-testid="ledger-drilldown-btn"
                  onClick={() => setDetailSessionId(row.sessionId!)}
                  startDecorator={<QueryStatsIcon fontSize="small" />}
                >
                  Session
                </Button>
              </Tooltip>
            ) : null
          }
        />
      )}

      <SessionUsageDetailModal
        sessionId={detailSessionId}
        organizationId={fixedOrgId}
        onClose={() => setDetailSessionId(null)}
      />
    </Stack>
  );
};
