import React, { useState, useMemo, useEffect } from 'react';
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
import { useUserActivityFilters } from '@client/app/hooks/useUserActivityFilters';
import { useExportToCSV } from '@client/app/hooks/useExportToCSV';
import { useAnalyticsStore, ALL_VALUE } from '../store';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { UserActivityFilters } from '../filters/UserActivityFilters';

interface UserActivityTabProps {
  rawData: any[];
  loading: boolean;
  onRefresh: () => void;
  onExport?: React.MutableRefObject<(() => void) | null>;
}

interface ActivityData {
  date: string;
  counterName: string;
  userEmail: string;
  metadata: Record<string, any>;
  count: number;
}

export const UserActivityTab: React.FC<UserActivityTabProps> = ({
  rawData,
  loading,
  onRefresh,
  onExport: onExportRef,
}) => {
  const isMobile = useIsMobile();
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [expandedMetadata, setExpandedMetadata] = useState<Set<string>>(new Set());
  const {
    dateFilters,
    selectedOrganizations,
    setSelectedOrganizations,
    excludedOrgs,
    toggleExcludedOrg,
    userActivityFilters,
    showUserActivityAdvancedFilters,
    setShowUserActivityAdvancedFilters,
  } = useAnalyticsStore();
  const { filters, updateFilter, transformData } = useUserActivityFilters();
  const orgsResponse = useGetAllOrganizations({ filters: { personal: false } });

  // Initialize filters with dateFilters and userActivityFilters from store
  useEffect(() => {
    if (filters.startDate !== dateFilters.startDate) {
      updateFilter('startDate', dateFilters.startDate);
    }
    if (filters.endDate !== dateFilters.endDate) {
      updateFilter('endDate', dateFilters.endDate);
    }

    if (filters.counterNameSearch !== userActivityFilters.counterNameSearch) {
      updateFilter('counterNameSearch', userActivityFilters.counterNameSearch);
    }
    if (filters.userEmailSearch !== userActivityFilters.userEmailSearch) {
      updateFilter('userEmailSearch', userActivityFilters.userEmailSearch);
    }
  }, [
    dateFilters.startDate,
    dateFilters.endDate,
    userActivityFilters.counterNameSearch,
    userActivityFilters.userEmailSearch,
    filters.startDate,
    filters.endDate,
    filters.counterNameSearch,
    filters.userEmailSearch,
    updateFilter,
  ]);

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

  const filteredData = useMemo(() => {
    return transformData(rawData);
  }, [rawData, transformData]);

  // Export data when called from parent
  useEffect(() => {
    if (onExportRef) {
      const exportHandler = () => {
        const csvData = filteredData.map((item: ActivityData) => ({
          date: item.date,
          counterName: item.counterName,
          userEmail: item.userEmail || 'N/A',
          metadata: JSON.stringify(item.metadata || {}),
          count: item.count || 0,
        }));

        exportToCSV(csvData, {
          filename: 'user_activity',
          customHeaders: ['date', 'counterName', 'userEmail', 'metadata', 'count'],
        });
      };

      // Store the export handler so parent can access it
      onExportRef.current = exportHandler;
    }
  }, [filteredData, onExportRef, exportToCSV]);

  // Pagination
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentItems = filteredData.slice(indexOfFirstItem, indexOfLastItem);
  const totalPages = Math.ceil(filteredData.length / itemsPerPage);

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

  const getMetadataSummary = (metadata: Record<string, any>) => {
    const keys = Object.keys(metadata || {});
    if (keys.length === 0) return 'No metadata';
    if (keys.length === 1) return `${keys[0]}: ${metadata[keys[0]]}`;
    return keys.join(', ');
  };

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
                        disabled={!selectedOrganizations.includes(ALL_VALUE)}
                        label="Million On Mars"
                        size="sm"
                      />
                      <Checkbox
                        checked={excludedOrgs.unknown}
                        onChange={() => toggleExcludedOrg('unknown')}
                        disabled={!selectedOrganizations.includes(ALL_VALUE)}
                        label="Unknown"
                        size="sm"
                      />
                      <Checkbox
                        checked={excludedOrgs.personal}
                        onChange={() => toggleExcludedOrg('personal')}
                        disabled={!selectedOrganizations.includes(ALL_VALUE)}
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
                  sx={{ flex: { xs: 1, sm: 'none' } }}
                >
                  Refresh
                </Button>
                <Button
                  size="sm"
                  startDecorator={<DownloadIcon />}
                  onClick={() => onExportRef?.current?.()}
                  disabled={loading}
                  color="success"
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

          {/* Advanced Filters Section */}
          {showUserActivityAdvancedFilters && (
            <>
              <Divider />
              <UserActivityFilters filters={filters} updateFilter={updateFilter} rawData={rawData} />
            </>
          )}
        </Stack>
      </Card>

      {/* Results */}
      {loading ? (
        <LinearProgress />
      ) : filteredData.length === 0 ? (
        <Card variant="outlined" sx={{ p: 4, textAlign: 'center' }}>
          <Stack alignItems="center" spacing={2}>
            <SearchOffIcon sx={{ fontSize: 48, color: 'neutral.500' }} />
            <Typography level="body-lg">No data found</Typography>
          </Stack>
        </Card>
      ) : (
        <>
          <SharedPaginationControls
            currentPage={currentPage}
            totalPages={totalPages}
            itemsPerPage={itemsPerPage}
            totalItems={filteredData.length}
            onPageChange={setCurrentPage}
            onItemsPerPageChange={size => {
              setItemsPerPage(size);
              setCurrentPage(1);
            }}
            pageLimitOptions={[5, 10, 20]}
          />
          {isMobile ? (
            /* Mobile: card-per-row layout */
            <Stack spacing={1}>
              {currentItems.map((item: ActivityData, index) => {
                const itemKey = `${item.date}-${item.counterName}-${item.userEmail}-${item.metadata?.reportId}-${index}`;
                const hasMetadata = Object.keys(item.metadata || {}).length > 0;
                return (
                  <Card
                    variant="outlined"
                    key={itemKey}
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
              {currentItems.map((item: ActivityData, index) => {
                const itemKey = `${item.date}-${item.counterName}-${item.userEmail}-${item.metadata?.reportId}-${index}`;
                return (
                  <Card
                    variant="outlined"
                    key={itemKey}
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
