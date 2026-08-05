import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandIcon from '@mui/icons-material/Expand';
import FilterListIcon from '@mui/icons-material/FilterList';
import HikingIcon from '@mui/icons-material/Hiking';
import HistoryIcon from '@mui/icons-material/History';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import RefreshIcon from '@mui/icons-material/Refresh';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import { Badge, Box, Button, Card, Chip, IconButton, Input, Option, Select, Stack, Tooltip } from '@mui/joy';
import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import OrganizationsFilter from './filters/OrganizationsFilter';
import SortControls from './filters/SortControls';
import UserTagsFilter from './filters/UserTagsFilter';
import { CLEARED_FILTER_PARAMS, countActiveFilters, useUsersTab } from './useUsersTabParams';

export type UsersDisplayMode = 'full' | 'slim' | 'userJourney' | 'recentActivity';

const DISPLAY_MODES: { value: UsersDisplayMode; label: string; icon: React.ReactNode }[] = [
  { value: 'slim', label: 'Slim', icon: <UnfoldLessIcon fontSize="small" /> },
  { value: 'full', label: 'Full', icon: <ExpandIcon fontSize="small" /> },
  { value: 'userJourney', label: 'User Journey', icon: <HikingIcon fontSize="small" /> },
  { value: 'recentActivity', label: 'Recent Activity', icon: <HistoryIcon fontSize="small" /> },
];

interface UsersFilterBarProps {
  displayMode: UsersDisplayMode;
  onDisplayModeChange: (mode: UsersDisplayMode) => void;
  loading: boolean;
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onDownloadCsv: () => void;
  onCreateUser: () => void;
  downloadDisabled: boolean;
  /** Mobile only: opens the filter drawer that hosts org/tag/sort controls. */
  onOpenFilters: () => void;
}

const UsersFilterBar: React.FC<UsersFilterBarProps> = ({
  displayMode,
  onDisplayModeChange,
  loading,
  search,
  onSearchChange,
  onRefresh,
  onDownloadCsv,
  onCreateUser,
  downloadDisabled,
  onOpenFilters,
}) => {
  const isMobile = useIsMobile();
  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));
  const activeFilterCount = countActiveFilters(params);

  const searchInput = (
    <Input
      data-testid="admin-search-users-input"
      size="sm"
      startDecorator={<PersonSearchIcon />}
      endDecorator={
        search ? (
          <IconButton
            data-testid="admin-search-clear-btn"
            size="sm"
            variant="plain"
            color="neutral"
            aria-label="Clear search"
            onClick={() => onSearchChange('')}
          >
            <CloseIcon />
          </IconButton>
        ) : null
      }
      placeholder="Search users"
      value={search}
      onChange={event => onSearchChange(event.target.value)}
      sx={{ flex: 1, minWidth: 0 }}
    />
  );

  const viewModeSelect = (
    <Select
      data-testid="admin-view-mode-select"
      size="sm"
      value={displayMode}
      onChange={(_, value) => {
        if (value) onDisplayModeChange(value);
      }}
      disabled={loading}
      sx={{ minWidth: isMobile ? 110 : 170, flexShrink: 0 }}
      renderValue={option => {
        const mode = DISPLAY_MODES.find(m => m.value === option?.value);
        return (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {mode?.icon}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mode?.label}
            </Box>
          </Box>
        );
      }}
    >
      {DISPLAY_MODES.map(mode => (
        <Option key={mode.value} value={mode.value}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {mode.icon}
            {mode.label}
          </Box>
        </Option>
      ))}
    </Select>
  );

  const createUserButton = (label: boolean) =>
    label ? (
      <Button
        data-testid="admin-create-user-btn"
        size="sm"
        color="primary"
        startDecorator={<PersonAddIcon />}
        onClick={onCreateUser}
        sx={{ flexShrink: 0 }}
      >
        Create User
      </Button>
    ) : (
      <Tooltip title="Create User">
        <IconButton
          data-testid="admin-create-user-btn"
          // Tooltip only sets aria-describedby, so icon-only buttons still need their own name.
          aria-label="Create user"
          size="sm"
          variant="solid"
          color="primary"
          onClick={onCreateUser}
        >
          <PersonAddIcon />
        </IconButton>
      </Tooltip>
    );

  const refreshButton = (
    <Tooltip title="Refresh">
      <IconButton
        data-testid="admin-refresh-btn"
        aria-label="Refresh users"
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={loading}
        onClick={onRefresh}
      >
        <RefreshIcon />
      </IconButton>
    </Tooltip>
  );

  const downloadButton = (
    <Tooltip title="Download CSV">
      <IconButton
        data-testid="admin-download-csv-btn"
        aria-label="Download users CSV"
        size="sm"
        variant="outlined"
        color="neutral"
        disabled={downloadDisabled}
        onClick={onDownloadCsv}
      >
        <DownloadIcon />
      </IconButton>
    </Tooltip>
  );

  // Create User is the only accented control, so the secondary actions share one quiet style.
  const helpButton = (
    <ContextHelpButton
      helpId="admin/user-management"
      tooltipText="User Management Help"
      variant="outlined"
      data-testid="admin-help-btn"
    />
  );

  if (isMobile) {
    return (
      <Card sx={{ px: 1, py: 0.75, gap: 0.75 }}>
        <Stack direction="row" spacing={0.75} alignItems="center">
          {searchInput}
          {viewModeSelect}
          <IconButton
            data-testid="admin-users-filter-toggle"
            aria-label="Open filters"
            size="sm"
            variant={activeFilterCount > 0 ? 'soft' : 'outlined'}
            color={activeFilterCount > 0 ? 'primary' : 'neutral'}
            onClick={onOpenFilters}
            sx={{ flexShrink: 0 }}
          >
            <Badge badgeContent={activeFilterCount} badgeInset="14%" size="sm" invisible={activeFilterCount === 0}>
              <FilterListIcon />
            </Badge>
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={0.75} alignItems="center" justifyContent="flex-end">
          {createUserButton(false)}
          {refreshButton}
          {downloadButton}
          {helpButton}
        </Stack>
      </Card>
    );
  }

  return (
    <Card sx={{ px: 2, py: 1, gap: 1 }}>
      {/* Search stretches into the remaining space so the row has no dead gap. */}
      <Stack direction="row" spacing={1} alignItems="center">
        {searchInput}
        {viewModeSelect}
        {createUserButton(true)}
        {refreshButton}
        {downloadButton}
        {helpButton}
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <OrganizationsFilter disabled={loading} />
        <UserTagsFilter disabled={loading} />
        <SortControls disabled={loading} />
        {activeFilterCount > 0 && (
          <Chip
            data-testid="admin-clear-filters-chip"
            size="sm"
            variant="soft"
            color="primary"
            endDecorator={<CloseIcon sx={{ fontSize: 14 }} />}
            onClick={() => setParams(CLEARED_FILTER_PARAMS)}
          >
            {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
          </Chip>
        )}
      </Stack>
    </Card>
  );
};

export default UsersFilterBar;
