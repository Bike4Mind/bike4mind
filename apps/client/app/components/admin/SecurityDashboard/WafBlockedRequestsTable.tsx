import {
  Box,
  Checkbox,
  Chip,
  Dropdown,
  IconButton,
  Input,
  List,
  ListItem,
  Menu,
  MenuButton,
  Sheet,
  Stack,
  Table,
  Typography,
} from '@mui/joy';
import { useMemo, useState } from 'react';
import type { SecurityDashboardWafBlockedRequestsResult } from '@/app/hooks/data/admin';
import type { WafRangeInput } from '@/server/security/wafTraffic';
import { formatRangeLabel } from './wafRangeLabel';

const PAGE_SIZE = 20;

interface WafBlockedRequestsTableProps {
  data?: SecurityDashboardWafBlockedRequestsResult;
  range: WafRangeInput;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
}

type FilterKey = 'action' | 'terminatingRuleId' | 'clientIp' | 'country' | 'httpMethod' | 'uri' | 'httpVersion';

function formatTimestamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC');
}

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? `${value.slice(0, maxLen)}…` : value;
}

function AutoFilterHeader({
  label,
  columnKey,
  options,
  selected,
  onChange,
  open,
  onOpenChange,
}: {
  label: string;
  columnKey: FilterKey;
  options: string[];
  selected: string[];
  onChange: (key: FilterKey, values: string[]) => void;
  open: boolean;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const isFiltered = selected.length > 0;

  const visibleOptions = search.trim()
    ? options.filter(o => o.toLowerCase().includes(search.trim().toLowerCase()))
    : options;

  const toggleAll = () => onChange(columnKey, []);

  const toggleValue = (val: string) => {
    if (selected.includes(val)) {
      onChange(
        columnKey,
        selected.filter(v => v !== val)
      );
    } else {
      onChange(columnKey, [...selected, val]);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) setSearch('');
    onOpenChange(isOpen);
  };

  return (
    <Dropdown open={open} onOpenChange={(_, isOpen) => handleOpenChange(isOpen)}>
      <MenuButton
        size="sm"
        variant="plain"
        color={isFiltered ? 'primary' : 'neutral'}
        sx={{
          fontWeight: 700,
          fontSize: '0.75rem',
          px: 0.5,
          py: 0.25,
          gap: 0.25,
          minHeight: 0,
          width: '100%',
          justifyContent: 'space-between',
          borderRadius: 'sm',
          '&:hover': { bgcolor: 'neutral.softHoverBg' },
        }}
        data-testid={`filter-btn-${columnKey}`}
      >
        <span>{label}</span>
        <span style={{ fontSize: '0.6rem', opacity: isFiltered ? 1 : 0.4 }}>▼</span>
      </MenuButton>
      <Menu size="sm" placement="bottom-start" sx={{ minWidth: 200, p: 0.5, zIndex: 1400 }}>
        <Box sx={{ px: 0.5, pb: 0.5 }}>
          <Input
            size="sm"
            placeholder={`Search ${label}…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
            onKeyDown={e => {
              if (e.key !== 'Escape') e.stopPropagation();
            }}
            autoFocus
            sx={{ fontSize: '0.75rem' }}
            data-testid={`filter-search-${columnKey}`}
          />
        </Box>
        <Box sx={{ maxHeight: 240, overflowY: 'auto' }}>
          <List size="sm" sx={{ '--List-gap': '0px', '--ListItem-paddingY': '2px' }}>
            {!search.trim() && (
              <ListItem>
                <Checkbox
                  size="sm"
                  label="(All)"
                  checked={selected.length === 0}
                  indeterminate={selected.length > 0 && selected.length < options.length}
                  onChange={toggleAll}
                  sx={{ fontSize: '0.75rem' }}
                />
              </ListItem>
            )}
            {visibleOptions.map(opt => (
              <ListItem key={opt}>
                <Checkbox
                  size="sm"
                  label={opt || '(empty)'}
                  checked={selected.length === 0 || selected.includes(opt)}
                  onChange={() => toggleValue(opt)}
                  sx={{
                    fontSize: '0.75rem',
                    fontFamily: opt.includes('.') || opt.match(/^\d/) ? 'monospace' : undefined,
                  }}
                />
              </ListItem>
            ))}
            {visibleOptions.length === 0 && (
              <ListItem>
                <Typography level="body-xs" sx={{ color: 'neutral.500', py: 0.5 }}>
                  No matches
                </Typography>
              </ListItem>
            )}
          </List>
        </Box>
      </Menu>
    </Dropdown>
  );
}

export const WafBlockedRequestsTable = ({ data, range, isLoading, isError, error }: WafBlockedRequestsTableProps) => {
  const [page, setPage] = useState(0);
  const [openColumn, setOpenColumn] = useState<FilterKey | null>(null);
  const [filters, setFilters] = useState<Record<FilterKey, string[]>>({
    action: [],
    terminatingRuleId: [],
    clientIp: [],
    country: [],
    httpMethod: [],
    uri: [],
    httpVersion: [],
  });

  const setFilter = (key: FilterKey, values: string[]) => {
    setFilters(prev => ({ ...prev, [key]: values }));
    setPage(0);
  };

  const requests = data?.requests ?? [];

  const options = useMemo(
    () => ({
      action: [...new Set(requests.map(r => r.action))].sort(),
      terminatingRuleId: [...new Set(requests.map(r => r.terminatingRuleId))].sort(),
      clientIp: [...new Set(requests.map(r => r.clientIp))].sort(),
      country: [...new Set(requests.map(r => r.country))].sort(),
      httpMethod: [...new Set(requests.map(r => r.httpMethod))].sort(),
      uri: [...new Set(requests.map(r => r.uri))].sort(),
      httpVersion: [...new Set(requests.map(r => r.httpVersion))].sort(),
    }),
    [requests]
  );

  const filtered = useMemo(() => {
    return requests.filter(row => {
      const checks: [FilterKey, string][] = [
        ['action', row.action],
        ['terminatingRuleId', row.terminatingRuleId],
        ['clientIp', row.clientIp],
        ['country', row.country],
        ['httpMethod', row.httpMethod],
        ['uri', row.uri],
        ['httpVersion', row.httpVersion],
      ];
      return checks.every(([key, val]) => {
        const sel = filters[key];
        return sel.length === 0 || sel.includes(val);
      });
    });
  }, [requests, filters]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const start = filtered.length === 0 ? 0 : safePage * PAGE_SIZE + 1;
  const end = Math.min(safePage * PAGE_SIZE + PAGE_SIZE, filtered.length);
  const isAnyFiltered = Object.values(filters).some(v => v.length > 0);

  return (
    <Box sx={{ mt: 3 }} data-testid="waf-blocked-requests-table-section">
      <Stack direction="row" justifyContent="space-between" alignItems="baseline" sx={{ mb: 1 }}>
        <Typography level="title-sm" sx={{ fontWeight: 700 }}>
          Blocked HTTP requests (CloudWatch Logs)
        </Typography>
        <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
          {formatRangeLabel(range)} • up to 1000 rows
        </Typography>
      </Stack>

      {isLoading && (
        <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-blocked-requests-loading">
          Loading blocked requests…
        </Typography>
      )}

      {isError && (
        <Typography level="body-sm" sx={{ color: 'danger.500' }} data-testid="waf-blocked-requests-error">
          Failed to load blocked requests: {error instanceof Error ? error.message : String(error)}
        </Typography>
      )}

      {data?.enabled === false && (
        <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-blocked-requests-disabled-msg">
          {data.reason === 'no-logging-config'
            ? 'WAF logging is not configured for the Router WebACL.'
            : data.reason === 'no-webacl'
              ? 'No WebACL is attached to the Router CloudFront distribution for this stage.'
              : 'Blocked request logs are currently unavailable for this stage.'}
        </Typography>
      )}

      {data?.enabled && (
        <>
          {requests.length === 0 ? (
            <Typography level="body-sm" sx={{ color: 'neutral.600' }} data-testid="waf-blocked-requests-empty">
              No blocked requests in the selected window.
            </Typography>
          ) : (
            <>
              <Sheet
                variant="outlined"
                sx={{ borderRadius: 'md', overflow: 'hidden' }}
                data-testid="waf-blocked-requests-table"
              >
                <Box sx={{ overflowX: 'auto' }}>
                  <Table
                    size="sm"
                    stickyHeader
                    sx={{
                      '& thead th': {
                        whiteSpace: 'nowrap',
                        fontWeight: 700,
                        fontSize: '0.75rem',
                        verticalAlign: 'middle',
                      },
                      '& tbody td': { fontSize: '0.75rem', verticalAlign: 'top' },
                      minWidth: 1100,
                    }}
                  >
                    <thead>
                      <tr>
                        <th style={{ width: 160 }}>Time</th>
                        <th style={{ width: 80 }}>
                          <AutoFilterHeader
                            label="Action"
                            columnKey="action"
                            options={options.action}
                            selected={filters.action}
                            onChange={setFilter}
                            open={openColumn === 'action'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'action' : null)}
                          />
                        </th>
                        <th style={{ width: 160 }}>
                          <AutoFilterHeader
                            label="Terminating Rule"
                            columnKey="terminatingRuleId"
                            options={options.terminatingRuleId}
                            selected={filters.terminatingRuleId}
                            onChange={setFilter}
                            open={openColumn === 'terminatingRuleId'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'terminatingRuleId' : null)}
                          />
                        </th>
                        <th style={{ width: 130 }}>
                          <AutoFilterHeader
                            label="Client IP"
                            columnKey="clientIp"
                            options={options.clientIp}
                            selected={filters.clientIp}
                            onChange={setFilter}
                            open={openColumn === 'clientIp'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'clientIp' : null)}
                          />
                        </th>
                        <th style={{ width: 72 }}>
                          <AutoFilterHeader
                            label="Country"
                            columnKey="country"
                            options={options.country}
                            selected={filters.country}
                            onChange={setFilter}
                            open={openColumn === 'country'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'country' : null)}
                          />
                        </th>
                        <th style={{ width: 72 }}>
                          <AutoFilterHeader
                            label="Method"
                            columnKey="httpMethod"
                            options={options.httpMethod}
                            selected={filters.httpMethod}
                            onChange={setFilter}
                            open={openColumn === 'httpMethod'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'httpMethod' : null)}
                          />
                        </th>
                        <th>
                          <AutoFilterHeader
                            label="URI"
                            columnKey="uri"
                            options={options.uri}
                            selected={filters.uri}
                            onChange={setFilter}
                            open={openColumn === 'uri'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'uri' : null)}
                          />
                        </th>
                        <th style={{ width: 120 }}>Args</th>
                        <th style={{ width: 88 }}>
                          <AutoFilterHeader
                            label="HTTP Ver."
                            columnKey="httpVersion"
                            options={options.httpVersion}
                            selected={filters.httpVersion}
                            onChange={setFilter}
                            open={openColumn === 'httpVersion'}
                            onOpenChange={isOpen => setOpenColumn(isOpen ? 'httpVersion' : null)}
                          />
                        </th>
                        <th style={{ width: 160 }}>Request ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((row, idx) => (
                        <tr key={`${row.requestId}-${idx}`}>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatTimestamp(row.timestamp)}</td>
                          <td>
                            <Chip size="sm" color="danger" variant="soft" data-testid="waf-blocked-action-chip">
                              {row.action}
                            </Chip>
                          </td>
                          <td title={row.terminatingRuleId}>{truncate(row.terminatingRuleId, 28)}</td>
                          <td>{row.clientIp}</td>
                          <td>{row.country}</td>
                          <td>{row.httpMethod}</td>
                          <td title={row.uri}>{truncate(row.uri, 60)}</td>
                          <td title={row.args}>{truncate(row.args, 18)}</td>
                          <td>{row.httpVersion}</td>
                          <td>
                            <Typography level="body-xs" sx={{ fontFamily: 'monospace' }} title={row.requestId}>
                              {truncate(row.requestId, 20)}
                            </Typography>
                          </td>
                        </tr>
                      ))}
                      {filtered.length === 0 && (
                        <tr>
                          <td colSpan={10}>
                            <Typography level="body-xs" sx={{ color: 'neutral.500', py: 1, textAlign: 'center' }}>
                              No rows match the current filters.
                            </Typography>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </Table>
                </Box>
              </Sheet>

              {/* Pagination */}
              <Stack
                direction="row"
                justifyContent="space-between"
                alignItems="center"
                sx={{ mt: 1 }}
                data-testid="waf-blocked-requests-pagination"
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography level="body-xs" sx={{ color: 'neutral.500' }}>
                    {start}–{end} of {filtered.length} rows
                    {filtered.length !== requests.length && ` (filtered from ${requests.length})`}
                  </Typography>
                  {isAnyFiltered && (
                    <Typography
                      level="body-xs"
                      sx={{ color: 'primary.500', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() =>
                        setFilters({
                          action: [],
                          terminatingRuleId: [],
                          clientIp: [],
                          country: [],
                          httpMethod: [],
                          uri: [],
                          httpVersion: [],
                        })
                      }
                      data-testid="waf-clear-filters"
                    >
                      Clear filters
                    </Typography>
                  )}
                </Stack>
                <Stack direction="row" spacing={0.5} alignItems="center">
                  <IconButton
                    size="sm"
                    variant="soft"
                    color="neutral"
                    disabled={safePage === 0}
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    data-testid="waf-blocked-requests-prev-btn"
                  >
                    {'<'}
                  </IconButton>
                  <Typography level="body-xs">
                    Page {safePage + 1} of {totalPages}
                  </Typography>
                  <IconButton
                    size="sm"
                    variant="soft"
                    color="neutral"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    data-testid="waf-blocked-requests-next-btn"
                  >
                    {'>'}
                  </IconButton>
                </Stack>
              </Stack>
            </>
          )}
        </>
      )}
    </Box>
  );
};
