import { useMemo, useState } from 'react';
import { Autocomplete, AutocompleteOption, Box, Button, Stack, Typography } from '@mui/joy';
import type { SecurityDashboardWafBlockedRequestsResult } from '@/app/hooks/data/admin';
import type { WafRangeInput } from '@/server/security/wafTraffic';
import { DataTable, EmptyState, ErrorState, StatusChip } from '../shared';
import { formatRangeLabel } from './wafRangeLabel';

interface WafBlockedRequestsTableProps {
  data?: SecurityDashboardWafBlockedRequestsResult;
  range: WafRangeInput;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?(): void;
}
const FILTERS = [
  ['action', 'Action'],
  ['terminatingRuleId', 'Terminating rule'],
  ['clientIp', 'Client IP'],
  ['country', 'Country'],
  ['httpMethod', 'Method'],
  ['uri', 'URI'],
  ['httpVersion', 'HTTP version'],
] as const;
type FilterKey = (typeof FILTERS)[number][0];

export const WafBlockedRequestsTable = ({
  data,
  range,
  isLoading,
  isError,
  error,
  onRetry = () => {},
}: WafBlockedRequestsTableProps) => {
  const [filters, setFilters] = useState<Partial<Record<FilterKey, string[]>>>({});
  const requests = data?.requests;
  const rows = useMemo(
    () => (requests ?? []).map((row, index) => ({ ...row, id: `${row.requestId}-${index}` })),
    [requests]
  );
  const filtered = rows.filter(row =>
    FILTERS.every(([key]) => !filters[key]?.length || filters[key]?.includes(row[key]))
  );
  return (
    <Stack spacing={1} data-testid="waf-blocked-requests-table-section">
      <Typography level="title-sm">Blocked HTTP requests</Typography>
      <Typography level="body-sm">{formatRangeLabel(range)} - up to 1000 loaded rows</Typography>
      {isError ? (
        <Box data-testid="waf-blocked-requests-error">
          <ErrorState
            message={`Failed to load blocked requests: ${error instanceof Error ? error.message : String(error)}`}
            onRetry={onRetry}
          />
        </Box>
      ) : data?.enabled === false ? (
        <Box data-testid="waf-blocked-requests-disabled-msg">
          <EmptyState
            title={
              data.reason === 'no-logging-config'
                ? 'WAF logging is not configured.'
                : data.reason === 'no-webacl'
                  ? 'No WebACL is attached for this stage.'
                  : 'Blocked request logs are unavailable.'
            }
            action={
              <Button onClick={onRetry} data-testid="waf-blocked-retry-btn">
                Refresh logs
              </Button>
            }
          />
        </Box>
      ) : (
        <>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {FILTERS.map(([key, label]) => (
              <Autocomplete
                key={key}
                multiple
                value={filters[key] ?? []}
                placeholder={label}
                aria-label={label}
                data-testid={`filter-btn-${key}`}
                options={[...new Set(rows.map(row => row[key]))].sort()}
                getOptionLabel={value => value || '(empty)'}
                slotProps={{ input: { 'data-testid': `filter-search-${key}` } }}
                renderOption={(props, value) => (
                  <AutocompleteOption {...props} key={value} data-testid={`waf-filter-${key}-${value}`}>
                    {value || '(empty)'}
                  </AutocompleteOption>
                )}
                onChange={(_, values) => setFilters(previous => ({ ...previous, [key]: values }))}
              />
            ))}
            {Object.values(filters).some(values => values.length > 0) && (
              <Button variant="plain" onClick={() => setFilters({})} data-testid="waf-clear-filters">
                Clear filters
              </Button>
            )}
          </Stack>
          <DataTable
            rows={filtered}
            getRowId={row => row.id}
            label="Blocked requests"
            testId="waf-blocked-requests-table"
            loading={isLoading}
            onRetry={onRetry}
            pageResetKey={JSON.stringify({ range, filters })}
            columns={[
              { id: 'time', label: 'Time', render: row => new Date(row.timestamp).toUTCString() },
              { id: 'action', label: 'Action', render: row => <StatusChip tone="bad" label={row.action} /> },
              ...FILTERS.filter(([key]) => key !== 'action').map(([key, label]) => ({
                id: key,
                label,
                render: (row: (typeof rows)[number]) => (
                  <Typography level="body-sm" sx={{ overflowWrap: 'anywhere' }}>
                    {row[key]}
                  </Typography>
                ),
              })),
              {
                id: 'args',
                label: 'Args',
                render: row => <Typography sx={{ overflowWrap: 'anywhere' }}>{row.args}</Typography>,
              },
              {
                id: 'requestId',
                label: 'Request ID',
                render: row => (
                  <Typography sx={{ overflowWrap: 'anywhere', fontFamily: 'monospace' }}>{row.requestId}</Typography>
                ),
              },
            ]}
          />
        </>
      )}
    </Stack>
  );
};
