import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Stack,
  Typography,
  Button,
  FormControl,
  Divider,
  Checkbox,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  IconButton,
} from '@mui/joy';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useExportToCSV } from '@client/app/hooks/useExportToCSV';
import { fetchCounterLogs, type CounterLogRow } from '@client/app/utils/userAPICalls';
import { useAnalyticsStore, ALL_VALUE, isAllOrganizations } from './store';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { UserActivityFilters } from './filters/UserActivityFilters';
import { collectUserActivityRows, MAX_EXPORT_ROWS } from './exportUserActivity';
import { buildUserActivityRequest } from './userActivityRequest';
import { AnalyticsErrorCard } from './AnalyticsErrorCard';
import { DataTable, EmptyState, SettingsSection, type DataColumn } from '../../shared';

type KeyedRow = { item: CounterLogRow; key: string };

interface UserActivityTabProps {
  rows: CounterLogRow[];
  total: number;
  isFetching: boolean;
  error?: unknown;
  onRefresh: () => void;
}

export const UserActivityTab: React.FC<UserActivityTabProps> = ({ rows, total, isFetching, error, onRefresh }) => {
  const [expandedMetadata, setExpandedMetadata] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const {
    dateFilters,
    selectedOrganizations,
    setSelectedOrganizations,
    exclusions,
    toggleExclusion,
    userActivityFilters,
    metadataFilters,
    page,
    limit,
    setPage,
    setLimit,
    showUserActivityAdvancedFilters,
    setShowUserActivityAdvancedFilters,
  } = useAnalyticsStore();
  const orgsResponse = useGetAllOrganizations({ filters: { personal: false } });

  const exportToCSV = useExportToCSV();

  // Organizations from API
  const organizations = useMemo(() => {
    if (!orgsResponse.data) return [];
    return orgsResponse.data.map(org => org.name);
  }, [orgsResponse.data]);

  // Organization helper functions
  const getOrganizationDisplayLabel = () => {
    const selected = selectedOrganizations || [];

    if (isAllOrganizations(selected)) {
      return 'All Organizations';
    }

    if (selected.length === 1) {
      return selected[0];
    }

    return `${selected.length} Selected`;
  };

  const toggleOrganization = (orgName: string) => {
    const currentSelection = selectedOrganizations || [];

    if (orgName === 'all') {
      setSelectedOrganizations([ALL_VALUE]);
    } else {
      const withoutAll = currentSelection.filter(org => org !== ALL_VALUE);
      if (currentSelection.includes(orgName)) {
        setSelectedOrganizations(withoutAll.filter(org => org !== orgName));
      } else {
        setSelectedOrganizations([...withoutAll, orgName]);
      }
    }
  };

  const isAllSelected = isAllOrganizations(selectedOrganizations);

  /**
   * Export walks the pages itself: the grid holds a single server page, so exporting what is
   * rendered would silently drop everything else.
   */
  const handleExport = useCallback(async () => {
    setIsExporting(true);
    setExportNote(null);
    try {
      const request = buildUserActivityRequest({
        dateFilters,
        selectedOrganizations,
        exclusions,
        userActivityFilters,
        metadataFilters,
      });

      const {
        rows: allRows,
        total: walkedTotal,
        truncated,
      } = await collectUserActivityRows(
        (pageNumber, pageSize) =>
          fetchCounterLogs({ ...request, page: pageNumber, limit: pageSize }).then(response => ({
            logs: response.logs ?? [],
            total: response.total ?? 0,
          })),
        {
          onProgress: (collected, exportTotal) =>
            setExportNote(`Exporting ${collected.toLocaleString()} of ${exportTotal.toLocaleString()} rows...`),
        }
      );

      exportToCSV(
        allRows.map(row => ({
          date: row.date,
          counterName: row.counterName,
          userEmail: row.userEmail || 'N/A',
          metadata: JSON.stringify(row.metadata || {}),
          count: row.count || 0,
        })),
        { filename: 'user_activity', customHeaders: ['date', 'counterName', 'userEmail', 'metadata', 'count'] }
      );

      // walkedTotal, not the grid's `total` prop: the export re-queries, so this is the count
      // the truncation was measured against.
      setExportNote(
        truncated
          ? `Exported the first ${MAX_EXPORT_ROWS.toLocaleString()} of ${walkedTotal.toLocaleString()} rows.`
          : null
      );
    } catch (exportError) {
      setExportNote(exportError instanceof Error ? `Export failed: ${exportError.message}` : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  }, [dateFilters, exclusions, selectedOrganizations, userActivityFilters, metadataFilters, exportToCSV]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Helper functions for metadata display
  const toggleMetadataExpansion = (itemKey: string) => {
    const newExpanded = new Set(expandedMetadata);
    if (newExpanded.has(itemKey)) {
      newExpanded.delete(itemKey);
    } else {
      newExpanded.add(itemKey);
    }
    setExpandedMetadata(newExpanded);
  };

  const getMetadataSummary = (metadata: Record<string, unknown> = {}) => {
    const keys = Object.keys(metadata || {});
    if (keys.length === 0) return 'No metadata';
    if (keys.length === 1) return `${keys[0]}: ${metadata[keys[0]]}`;
    return keys.join(', ');
  };

  const rowKey = (item: CounterLogRow, index: number) =>
    `${item.date}-${item.counterName}-${item.userEmail}-${item.metadata?.reportId}-${index}`;

  const keyedRows = rows.map((item, index) => ({ item, key: rowKey(item, index) }));
  const columns: DataColumn<KeyedRow>[] = [
    { id: 'date', label: 'Date', width: '8rem', render: ({ item }) => item.date },
    { id: 'event', label: 'Action', width: '14rem', render: ({ item }) => item.counterName },
    { id: 'email', label: 'User Email', width: '14rem', render: ({ item }) => item.userEmail || 'N/A' },
    {
      id: 'metadata',
      label: 'Metadata',
      wrap: true,
      render: ({ item, key }) => {
        const hasMetadata = Object.keys(item.metadata || {}).length > 0;
        const expanded = hasMetadata && expandedMetadata.has(key);
        return (
          <Box sx={{ py: 0.5 }}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <Typography level="body-sm" sx={{ flex: 1, wordBreak: 'break-word' }}>
                {getMetadataSummary(item.metadata)}
              </Typography>
              {hasMetadata && (
                <IconButton
                  size="sm"
                  variant="plain"
                  aria-label={expanded ? 'Hide metadata' : 'Show metadata'}
                  aria-expanded={expanded}
                  data-testid="user-activity-metadata-toggle-btn"
                  onClick={() => toggleMetadataExpansion(key)}
                >
                  {expanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </IconButton>
              )}
            </Stack>
            {expanded && (
              <Box
                sx={{ borderRadius: 'sm', maxHeight: 150, overflow: 'auto' }}
                data-testid="user-activity-metadata-json"
              >
                <Typography
                  level="body-xs"
                  sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.75rem' }}
                >
                  {JSON.stringify(item.metadata, null, 2)}
                </Typography>
              </Box>
            )}
          </Box>
        );
      },
    },
    { id: 'count', label: 'Count', numeric: true, width: '5rem', render: ({ item }) => item.count || 0 },
  ];

  return (
    <Box>
      {/* User Activity Specific Filters */}
      <SettingsSection sx={{ mb: 1 }}>
        <Stack spacing={2}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            justifyContent="space-between"
            alignItems={{ xs: 'stretch', sm: 'center' }}
            spacing={{ xs: 2, sm: 0 }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 2, sm: 2 }} alignItems="flex-start">
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 2, sm: 3 }} flexWrap="wrap">
                {/* Organizations Filter */}
                <FormControl sx={{ minWidth: { xs: 0, sm: 200 }, width: { xs: '100%', sm: 'auto' } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5, display: { xs: 'none', sm: 'block' } }}>
                    Organizations
                  </Typography>
                  <Dropdown>
                    <MenuButton
                      data-testid="user-activity-org-menu-btn"
                      endDecorator={<KeyboardArrowDownIcon />}
                      sx={{
                        minWidth: { xs: 0, sm: 200 },
                        justifyContent: 'space-between',
                        textAlign: 'left',
                        fontWeight: 'normal',
                      }}
                    >
                      <Box
                        sx={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {getOrganizationDisplayLabel()}
                      </Box>
                    </MenuButton>
                    <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 200 }}>
                      <MenuItem onClick={() => toggleOrganization('all')} data-testid="user-activity-org-option-all">
                        <Checkbox checked={isAllSelected} onChange={() => toggleOrganization('all')} sx={{ mr: 1 }} />
                        All
                      </MenuItem>
                      {organizations?.map(org => (
                        <MenuItem
                          key={org}
                          onClick={() => toggleOrganization(org)}
                          data-testid={`user-activity-org-option-${org}`}
                        >
                          <Checkbox
                            checked={selectedOrganizations.includes(org)}
                            onChange={() => toggleOrganization(org)}
                            sx={{ mr: 1 }}
                          />
                          {org}
                        </MenuItem>
                      ))}
                    </Menu>
                  </Dropdown>
                </FormControl>

                <Box sx={{ minWidth: { xs: 0, sm: 300 }, width: { xs: '100%', sm: 'auto' } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    Accounts
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 2.5 }}>
                    <Stack
                      direction={'row'}
                      gap={2}
                      flexWrap="wrap"
                      alignItems="center"
                      data-testid="user-activity-exclude-orgs"
                    >
                      {/* A specific org selection already leaves out users without an org. */}
                      <Checkbox
                        checked={exclusions.noOrg}
                        onChange={() => toggleExclusion('noOrg')}
                        disabled={!isAllSelected}
                        label="Exclude users without an org"
                        size="sm"
                        data-testid="user-activity-exclude-no-org-checkbox"
                      />
                      <Checkbox
                        checked={exclusions.staff}
                        onChange={() => toggleExclusion('staff')}
                        label="Exclude staff and test accounts"
                        size="sm"
                        data-testid="user-activity-exclude-staff-checkbox"
                      />
                    </Stack>
                  </Box>
                </Box>
              </Stack>

              <Stack direction="row" gap={1} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                <Button
                  size="sm"
                  startDecorator={<RefreshIcon />}
                  onClick={onRefresh}
                  disabled={isFetching}
                  data-testid="user-activity-refresh-btn"
                  sx={{ flex: { xs: 1, sm: 'none' } }}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  startDecorator={<DownloadIcon />}
                  onClick={handleExport}
                  loading={isExporting}
                  disabled={isExporting}
                  color="success"
                  data-testid="user-activity-export-btn"
                  sx={{ flex: { xs: 1, sm: 'none' } }}
                >
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  variant={showUserActivityAdvancedFilters ? 'solid' : 'outlined'}
                  startDecorator={<FilterAltIcon />}
                  onClick={() => setShowUserActivityAdvancedFilters(!showUserActivityAdvancedFilters)}
                  sx={{ flex: { xs: 1, sm: 'none' } }}
                >
                  <Typography level="body-sm" sx={{ display: { xs: 'none', sm: 'inline' }, color: 'inherit' }}>
                    {showUserActivityAdvancedFilters ? 'Hide Advanced Filters' : 'Show Advanced Filters'}
                  </Typography>
                  <Typography level="body-sm" sx={{ display: { xs: 'inline', sm: 'none' }, color: 'inherit' }}>
                    Filters
                  </Typography>
                </Button>
              </Stack>
            </Stack>
          </Stack>

          {exportNote && (
            <Typography level="body-sm" color="warning" data-testid="user-activity-export-note">
              {exportNote}
            </Typography>
          )}

          {/* Advanced Filters Section */}
          {showUserActivityAdvancedFilters && (
            <>
              <Divider />
              <UserActivityFilters rows={rows} />
            </>
          )}
        </Stack>
      </SettingsSection>

      {/* Results */}
      {error ? (
        <AnalyticsErrorCard
          error={error}
          onRetry={onRefresh}
          title="Could not load user activity"
          testId="user-activity-error"
        />
      ) : (
        <Box
          data-testid="user-activity-results"
          sx={{ opacity: isFetching ? 0.55 : 1, transition: 'opacity 0.15s ease-in-out' }}
        >
          {/* Keyed on `total`, not on this page's rows: a page past the end of a shrunken result
              set has no rows, and hiding the controls there would leave no way back to page 1. */}
          {total > 0 && (
            <SharedPaginationControls
              currentPage={page}
              totalPages={totalPages}
              itemsPerPage={limit}
              totalItems={total}
              onPageChange={setPage}
              onItemsPerPageChange={setLimit}
              pageLimitOptions={[25, 50, 100]}
              disabled={isFetching}
            />
          )}
          <DataTable
            label="User activity"
            testId="user-activity-table"
            rows={keyedRows}
            columns={columns}
            getRowId={row => row.key}
            rowTestId={() => 'user-activity-row'}
            minWidth="57rem"
            pagination={false}
            onRetry={onRefresh}
            empty={
              <Box data-testid="user-activity-empty">
                <EmptyState
                  title="No activity found"
                  action={
                    <Button variant="outlined" onClick={onRefresh} data-testid="user-activity-empty-refresh-btn">
                      Refresh
                    </Button>
                  }
                />
              </Box>
            }
          />
        </Box>
      )}
    </Box>
  );
};
