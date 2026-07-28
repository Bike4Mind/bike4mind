import React, { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Card,
  Grid,
  LinearProgress,
  Stack,
  Typography,
  Button,
  FormControl,
  Tooltip,
  Divider,
  Checkbox,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  IconButton,
} from '@mui/joy';
import SharedPaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import SearchOffIcon from '@mui/icons-material/SearchOff';
import CalendarTodayIcon from '@mui/icons-material/CalendarToday';
import CategoryIcon from '@mui/icons-material/Category';
import EmailIcon from '@mui/icons-material/Email';
import InfoIcon from '@mui/icons-material/Info';
import NumbersIcon from '@mui/icons-material/Numbers';
import FilterAltIcon from '@mui/icons-material/FilterAlt';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useExportToCSV } from '@client/app/hooks/useExportToCSV';
import { fetchCounterLogs, type CounterLogRow } from '@client/app/utils/userAPICalls';
import { useAnalyticsStore, ALL_VALUE } from '../store';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { UserActivityFilters } from '../filters/UserActivityFilters';
import { collectUserActivityRows, MAX_EXPORT_ROWS } from '../exportUserActivity';
import { buildUserActivityRequest } from '../userActivityRequest';
import { AnalyticsErrorCard } from '../AnalyticsErrorCard';

interface UserActivityTabProps {
  rows: CounterLogRow[];
  total: number;
  loading: boolean;
  error?: unknown;
  onRefresh: () => void;
}

export const UserActivityTab: React.FC<UserActivityTabProps> = ({ rows, total, loading, error, onRefresh }) => {
  const isMobile = useIsMobile();
  const [expandedMetadata, setExpandedMetadata] = useState<Set<string>>(new Set());
  const [isExporting, setIsExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const {
    dateFilters,
    selectedOrganizations,
    setSelectedOrganizations,
    excludedOrgs,
    toggleExcludedOrg,
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

    if (selected.length === 0 || selected.includes(ALL_VALUE)) {
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

  const isAllSelected = selectedOrganizations.includes(ALL_VALUE);

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
        excludedOrgs,
        userActivityFilters,
        metadataFilters,
      });

      const { rows: allRows, truncated } = await collectUserActivityRows((pageNumber, pageSize) =>
        fetchCounterLogs({ ...request, page: pageNumber, limit: pageSize }).then(response => ({
          logs: response.logs ?? [],
          total: response.total ?? 0,
        }))
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

      if (truncated) {
        setExportNote(`Exported the first ${MAX_EXPORT_ROWS.toLocaleString()} of ${total.toLocaleString()} rows.`);
      }
    } catch (exportError) {
      setExportNote(exportError instanceof Error ? `Export failed: ${exportError.message}` : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  }, [dateFilters, excludedOrgs, selectedOrganizations, userActivityFilters, metadataFilters, exportToCSV, total]);

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

  return (
    <Box>
      {/* User Activity Specific Filters */}
      <Card sx={{ mb: 1 }}>
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
                      <MenuItem onClick={() => toggleOrganization('all')}>
                        <Checkbox
                          checked={selectedOrganizations.includes(ALL_VALUE)}
                          onChange={() => toggleOrganization('all')}
                          sx={{ mr: 1 }}
                        />
                        All
                      </MenuItem>
                      {organizations?.map(org => (
                        <MenuItem key={org} onClick={() => toggleOrganization(org)}>
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

                {/* Exclude Organizations */}
                <Box sx={{ minWidth: { xs: 0, sm: 300 }, width: { xs: '100%', sm: 'auto' } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    Exclude Organizations
                  </Typography>
                  <Box sx={{ display: 'flex', alignItems: 'center', minHeight: 2.5 }}>
                    <Stack direction={'row'} gap={2} flexWrap="wrap" alignItems="center">
                      <Checkbox
                        checked={excludedOrgs.millionOnMars}
                        onChange={() => toggleExcludedOrg('millionOnMars')}
                        disabled={!isAllSelected}
                        label="Million On Mars"
                        size="sm"
                      />
                      <Checkbox
                        checked={excludedOrgs.unknown}
                        onChange={() => toggleExcludedOrg('unknown')}
                        disabled={!isAllSelected}
                        label="Unknown"
                        size="sm"
                      />
                      <Checkbox
                        checked={excludedOrgs.personal}
                        onChange={() => toggleExcludedOrg('personal')}
                        disabled={!isAllSelected}
                        label="Personal"
                        size="sm"
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
                  disabled={loading}
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
                  disabled={loading || isExporting}
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
      </Card>

      {/* Results */}
      {loading ? (
        <LinearProgress />
      ) : error ? (
        <AnalyticsErrorCard
          error={error}
          onRetry={onRefresh}
          title="Could not load user activity"
          testId="user-activity-error"
        />
      ) : rows.length === 0 ? (
        <Card variant="outlined" sx={{ p: 4, textAlign: 'center' }} data-testid="user-activity-empty">
          <Stack alignItems="center" spacing={2}>
            <SearchOffIcon sx={{ fontSize: 48, color: 'neutral.500' }} />
            <Typography level="body-lg">No data found</Typography>
          </Stack>
        </Card>
      ) : (
        <>
          <SharedPaginationControls
            currentPage={page}
            totalPages={totalPages}
            itemsPerPage={limit}
            totalItems={total}
            onPageChange={setPage}
            onItemsPerPageChange={setLimit}
            pageLimitOptions={[25, 50, 100]}
          />
          {isMobile ? (
            /* Mobile: card-per-row layout */
            <Stack spacing={1}>
              {rows.map((item, index) => {
                const itemKey = rowKey(item, index);
                const hasMetadata = Object.keys(item.metadata || {}).length > 0;
                return (
                  <Card
                    variant="outlined"
                    key={itemKey}
                    data-testid="user-activity-row"
                    sx={{ bgcolor: index % 2 ? 'background.level1' : 'background.level2', p: 1.5 }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                          <Typography level="body-xs" color="primary" sx={{ whiteSpace: 'nowrap' }}>
                            {item.date}
                          </Typography>
                          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                            ·
                          </Typography>
                          <Typography
                            level="body-xs"
                            fontWeight="bold"
                            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {item.counterName}
                          </Typography>
                        </Stack>
                        <Typography level="body-xs" sx={{ color: 'text.secondary', mb: hasMetadata ? 0.5 : 0 }}>
                          {item.userEmail || 'N/A'}
                        </Typography>
                        {hasMetadata && (
                          <Typography
                            level="body-xs"
                            sx={{
                              color: 'text.tertiary',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {getMetadataSummary(item.metadata)}
                          </Typography>
                        )}
                        {expandedMetadata.has(itemKey) && hasMetadata && (
                          <Box sx={{ mt: 0.5, borderRadius: 'sm', maxHeight: 150, overflow: 'auto' }}>
                            <Typography
                              level="body-xs"
                              sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.75rem' }}
                            >
                              {JSON.stringify(item.metadata, null, 2)}
                            </Typography>
                          </Box>
                        )}
                      </Box>
                      <Stack alignItems="flex-end" spacing={0.5} sx={{ flexShrink: 0 }}>
                        <Typography level="body-sm" fontWeight="bold">
                          ×{item.count || 0}
                        </Typography>
                        {hasMetadata && (
                          <IconButton size="sm" variant="plain" onClick={() => toggleMetadataExpansion(itemKey)}>
                            {expandedMetadata.has(itemKey) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                          </IconButton>
                        )}
                      </Stack>
                    </Stack>
                  </Card>
                );
              })}
            </Stack>
          ) : (
            /* Desktop: sticky-header grid layout */
            <Box sx={{ maxHeight: 'calc(100vh - 100px)', overflow: 'auto' }}>
              <Card
                variant="outlined"
                sx={{ p: 1, mb: 1, position: 'sticky', top: 0, zIndex: 1, bgcolor: 'background.body' }}
              >
                <Grid container spacing={1} alignItems="center">
                  <Grid xs={1.3}>
                    <Tooltip title="Date">
                      <Typography level="title-sm" startDecorator={<CalendarTodayIcon />}>
                        Date
                      </Typography>
                    </Tooltip>
                  </Grid>
                  <Grid xs={2.7}>
                    <Tooltip title="Action">
                      <Typography level="title-sm" startDecorator={<CategoryIcon />}>
                        Action
                      </Typography>
                    </Tooltip>
                  </Grid>
                  <Grid xs={3}>
                    <Tooltip title="User Email">
                      <Typography level="title-sm" startDecorator={<EmailIcon />}>
                        User Email
                      </Typography>
                    </Tooltip>
                  </Grid>
                  <Grid xs={4}>
                    <Tooltip title="Metadata">
                      <Typography level="title-sm" startDecorator={<InfoIcon />}>
                        Metadata
                      </Typography>
                    </Tooltip>
                  </Grid>
                  <Grid xs={1}>
                    <Tooltip title="Count">
                      <Typography level="title-sm" startDecorator={<NumbersIcon />}>
                        Count
                      </Typography>
                    </Tooltip>
                  </Grid>
                </Grid>
              </Card>
              {rows.map((item, index) => {
                const itemKey = rowKey(item, index);
                return (
                  <Card
                    variant="outlined"
                    key={itemKey}
                    data-testid="user-activity-row"
                    sx={{ mb: 1, bgcolor: index % 2 ? 'background.level1' : 'background.level2' }}
                  >
                    <Grid container spacing={1} alignItems="center">
                      <Grid xs={1.3}>
                        <Typography color="primary" level="body-sm">
                          {item.date}
                        </Typography>
                      </Grid>
                      <Grid xs={2.7}>
                        <Typography level="body-sm">{item.counterName}</Typography>
                      </Grid>
                      <Grid xs={3}>
                        <Typography level="body-sm">{item.userEmail || 'N/A'}</Typography>
                      </Grid>
                      <Grid xs={4}>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <Typography
                            level="body-sm"
                            sx={{ flex: 1, wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: 1 }}
                          >
                            {getMetadataSummary(item.metadata)}
                          </Typography>
                          {Object.keys(item.metadata || {}).length > 0 && (
                            <IconButton size="sm" variant="plain" onClick={() => toggleMetadataExpansion(itemKey)}>
                              {expandedMetadata.has(itemKey) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                            </IconButton>
                          )}
                        </Stack>
                        {expandedMetadata.has(itemKey) && Object.keys(item.metadata || {}).length > 0 && (
                          <Box sx={{ borderRadius: 'sm', maxHeight: 150, overflow: 'auto' }}>
                            <Typography
                              level="body-xs"
                              sx={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.75rem' }}
                            >
                              {JSON.stringify(item.metadata, null, 2)}
                            </Typography>
                          </Box>
                        )}
                      </Grid>
                      <Grid xs={1}>
                        <Typography level="body-sm" textAlign="center">
                          {item.count || 0}
                        </Typography>
                      </Grid>
                    </Grid>
                  </Card>
                );
              })}
            </Box>
          )}
        </>
      )}
    </Box>
  );
};
