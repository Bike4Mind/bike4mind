import React, { useMemo, useState } from 'react';
import {
  Box,
  Stack,
  Typography,
  Button,
  Chip,
  Input,
  FormControl,
  Card,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
} from '@mui/joy';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import FilterListIcon from '@mui/icons-material/FilterList';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import dayjs from 'dayjs';
import { ModelMetric } from '../types';
import { getDisplayName } from '../utils/formatters';
import UsernameText from '@client/app/components/common/UsernameText';

interface ControlPanelProps {
  metrics: ModelMetric[];
  filteredMetrics: ModelMetric[];
  modelInfos: any[];
  // Filter states
  dateFrom: string;
  dateTo: string;
  userFilter: string;
  modelFilter: string;
  statusFilter: string;
  simplifiedNames: boolean;
  // Filter setters
  setDateFrom: (value: string) => void;
  setDateTo: (value: string) => void;
  setUserFilter: (value: string) => void;
  setModelFilter: (value: string) => void;
  setStatusFilter: (value: string) => void;
  setSimplifiedNames: (value: boolean) => void;
  // Actions
  onRefresh: () => void;
  onExportCSV: () => void;
  onClearFilters: () => void;
  onSetDateRange: (days: number) => void;
  onApplyFilters: () => void;
  isLoading?: boolean;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  metrics,
  filteredMetrics,
  modelInfos,
  dateFrom,
  dateTo,
  userFilter,
  modelFilter,
  statusFilter,
  simplifiedNames,
  setDateFrom,
  setDateTo,
  setUserFilter,
  setModelFilter,
  setStatusFilter,
  setSimplifiedNames,
  onRefresh,
  onExportCSV,
  onClearFilters,
  onSetDateRange,
  onApplyFilters,
  isLoading = false,
}) => {
  const uniqueUsers = useMemo(() => {
    const users = new Set(metrics.map(m => m.session?.userId).filter(Boolean));
    return Array.from(users).sort();
  }, [metrics]);

  const uniqueModels = useMemo(() => {
    const models = new Set(metrics.map(m => m.model?.name).filter(Boolean));
    return Array.from(models).sort();
  }, [metrics]);

  // Helper functions for display labels
  const getModelFilterDisplay = () => {
    if (!modelFilter) return 'All Models';
    return getDisplayName(modelFilter, modelInfos, simplifiedNames);
  };

  const getUserFilterDisplay = () => {
    if (!userFilter) return 'All Users';
    return <UsernameText id={userFilter} />;
  };

  const getStatusFilterDisplay = () => {
    if (!statusFilter) return 'All Status';
    return statusFilter.charAt(0).toUpperCase() + statusFilter.slice(1);
  };

  const isValidDateRange = useMemo(() => {
    if (!dateFrom || !dateTo) return true;
    return dayjs(dateFrom).isSameOrBefore(dayjs(dateTo));
  }, [dateFrom, dateTo]);

  const isMobile = useIsMobile();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const filtersOpen = !isMobile || mobileFiltersOpen;

  return (
    <Card sx={{ px: 2, py: 2, mb: { xs: 1, sm: 2 } }}>
      <Stack spacing={2}>
        {/* Mobile toggle */}
        {isMobile && (
          <Button
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<FilterListIcon />}
            endDecorator={
              <KeyboardArrowDownIcon
                sx={{ transform: mobileFiltersOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}
              />
            }
            onClick={() => setMobileFiltersOpen(v => !v)}
            sx={{ mb: 0.5 }}
          >
            {mobileFiltersOpen ? 'Hide Filters' : 'Show Filters'}
          </Button>
        )}

        {/* All Filters */}
        {filtersOpen && (
          <Stack
            direction={{ xs: 'column', xl: 'row' }}
            spacing={2}
            alignItems={{ xs: 'stretch', xl: 'end' }}
            justifyContent="space-between"
          >
            {/* Left Side - All Filters */}
            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems={{ xs: 'stretch', lg: 'end' }}>
              {/* Model + User + Status: 2-col on mobile (Status full-width row 2), auto row on desktop */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(2, 1fr)', lg: 'repeat(3, auto)' },
                  gap: 1,
                }}
              >
                <FormControl sx={{ minWidth: { lg: 150 } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    Model
                  </Typography>
                  <Dropdown>
                    <MenuButton
                      endDecorator={<KeyboardArrowDownIcon />}
                      sx={{
                        justifyContent: 'space-between',
                        textAlign: 'left',
                        fontWeight: 'normal',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getModelFilterDisplay()}
                      </Box>
                    </MenuButton>
                    <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 250 }}>
                      <MenuItem onClick={() => setModelFilter('')}>All Models</MenuItem>
                      {uniqueModels.map(model => (
                        <MenuItem key={model} onClick={() => setModelFilter(model)}>
                          {getDisplayName(model, modelInfos, simplifiedNames)}
                        </MenuItem>
                      ))}
                    </Menu>
                  </Dropdown>
                </FormControl>

                <FormControl sx={{ minWidth: { lg: 130 } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    User
                  </Typography>
                  <Dropdown>
                    <MenuButton
                      endDecorator={<KeyboardArrowDownIcon />}
                      sx={{
                        justifyContent: 'space-between',
                        textAlign: 'left',
                        fontWeight: 'normal',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {getUserFilterDisplay()}
                      </Box>
                    </MenuButton>
                    <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 200 }}>
                      <MenuItem onClick={() => setUserFilter('')}>All Users</MenuItem>
                      {uniqueUsers.map(user => (
                        <MenuItem key={user} onClick={() => setUserFilter(user!)}>
                          <UsernameText id={user as string} />
                        </MenuItem>
                      ))}
                    </Menu>
                  </Dropdown>
                </FormControl>

                <FormControl sx={{ gridColumn: { xs: '1 / -1', lg: 'auto' }, minWidth: { lg: 110 } }}>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    Status
                  </Typography>
                  <Dropdown>
                    <MenuButton
                      endDecorator={<KeyboardArrowDownIcon />}
                      sx={{
                        justifyContent: 'space-between',
                        textAlign: 'left',
                        fontWeight: 'normal',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {getStatusFilterDisplay()}
                    </MenuButton>
                    <Menu>
                      <MenuItem onClick={() => setStatusFilter('')}>All Status</MenuItem>
                      <MenuItem onClick={() => setStatusFilter('done')}>Done</MenuItem>
                      <MenuItem onClick={() => setStatusFilter('error')}>Error</MenuItem>
                      <MenuItem onClick={() => setStatusFilter('pending')}>Pending</MenuItem>
                    </Menu>
                  </Dropdown>
                </FormControl>
              </Box>

              {/* From Date + To Date: 2-col grid */}
              <Box
                sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', lg: 'repeat(2, auto)' }, gap: 1 }}
              >
                <FormControl>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    From Date
                  </Typography>
                  <Input
                    type="datetime-local"
                    value={dateFrom ? dayjs(dateFrom).format('YYYY-MM-DDTHH:mm') : ''}
                    onChange={e => setDateFrom(e.target.value ? dayjs(e.target.value).toISOString() : '')}
                    size="sm"
                    color={!isValidDateRange ? 'danger' : 'neutral'}
                  />
                </FormControl>

                <FormControl>
                  <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                    To Date
                  </Typography>
                  <Input
                    type="datetime-local"
                    value={dateTo ? dayjs(dateTo).format('YYYY-MM-DDTHH:mm') : ''}
                    onChange={e => setDateTo(e.target.value ? dayjs(e.target.value).toISOString() : '')}
                    size="sm"
                    color={!isValidDateRange ? 'danger' : 'neutral'}
                  />
                </FormControl>
              </Box>

              {/* Preset buttons + Apply: 3-col grid on mobile, auto row on desktop */}
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: 'repeat(3, 1fr)', lg: 'repeat(6, auto)' },
                  gap: 1,
                  alignItems: 'end',
                }}
              >
                <Button
                  size="sm"
                  variant="outlined"
                  onClick={() => {
                    const today = dayjs();
                    setDateFrom(today.startOf('day').toISOString());
                    setDateTo(today.endOf('day').toISOString());
                  }}
                  data-testid="filter-today"
                >
                  Today
                </Button>
                <Button size="sm" variant="outlined" onClick={() => onSetDateRange(0)} data-testid="filter-last-24h">
                  Last 24h
                </Button>
                <Button size="sm" variant="outlined" onClick={() => onSetDateRange(1)} data-testid="filter-yesterday">
                  Yesterday
                </Button>
                <Button size="sm" variant="outlined" onClick={() => onSetDateRange(7)} data-testid="filter-7d">
                  7d
                </Button>
                <Button size="sm" variant="outlined" onClick={() => onSetDateRange(30)} data-testid="filter-30d">
                  30d
                </Button>
                <Button
                  size="sm"
                  variant="solid"
                  color="primary"
                  onClick={onApplyFilters}
                  loading={isLoading}
                  disabled={!isValidDateRange}
                  sx={{ gridColumn: { xs: '1 / -1', lg: 'auto' }, whiteSpace: 'nowrap' }}
                >
                  Apply Filters
                </Button>
              </Box>
            </Stack>

            {/* Right Side - Action Buttons */}
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: { xs: 'repeat(2, 1fr)', xl: 'repeat(4, auto)' },
                gap: 1,
              }}
            >
              <Button
                variant={simplifiedNames ? 'solid' : 'outlined'}
                color={simplifiedNames ? 'primary' : 'neutral'}
                onClick={() => setSimplifiedNames(!simplifiedNames)}
                size="sm"
              >
                {simplifiedNames ? 'Full Names' : 'Simple Names'}
              </Button>
              <Button startDecorator={<RefreshIcon />} onClick={onRefresh} variant="outlined" size="sm">
                Refresh
              </Button>
              <Button
                startDecorator={<DownloadIcon />}
                onClick={onExportCSV}
                variant="outlined"
                size="sm"
                disabled={filteredMetrics.length === 0}
                color="success"
              >
                Export CSV
              </Button>
              <Button onClick={onClearFilters} variant="outlined" size="sm" color="danger">
                Clear All
              </Button>
            </Box>
          </Stack>
        )}

        {/* Active Filters & Status */}
        {filtersOpen && (dateFrom || dateTo || userFilter || modelFilter || statusFilter) && (
          <Box sx={{ p: 2, bgcolor: 'background.level2', borderRadius: 'sm' }}>
            <Typography level="body-sm" sx={{ fontWeight: 'bold', mb: 1 }}>
              Active Filters:
            </Typography>
            <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ gap: 1 }}>
              {dateFrom && (
                <Chip size="sm" variant="soft" color="primary">
                  From: {dayjs(dateFrom).format('MM/DD/YYYY HH:mm')}
                </Chip>
              )}
              {dateTo && (
                <Chip size="sm" variant="soft" color="primary">
                  To: {dayjs(dateTo).format('MM/DD/YYYY HH:mm')}
                </Chip>
              )}
              {userFilter && (
                <Chip size="sm" variant="soft" color="primary">
                  User: <UsernameText id={userFilter} />
                </Chip>
              )}
              {modelFilter && (
                <Chip size="sm" variant="soft" color="primary">
                  Model: {getDisplayName(modelFilter, modelInfos, simplifiedNames)}
                </Chip>
              )}
              {statusFilter && (
                <Chip size="sm" variant="soft" color="primary">
                  Status: {statusFilter}
                </Chip>
              )}
            </Stack>
          </Box>
        )}

        {filtersOpen && !isValidDateRange && (
          <Typography level="body-sm" sx={{ color: 'danger.500' }}>
            ⚠️ From date must be before or equal to To date
          </Typography>
        )}
      </Stack>
    </Card>
  );
};
