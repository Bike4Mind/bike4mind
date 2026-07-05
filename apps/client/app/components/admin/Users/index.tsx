import { useGetUsers, useGetUserTags } from '@client/app/hooks/data/user';
import { IGetUsersParams, fetchUsers } from '@client/app/utils/userAPICalls';
import ExpandIcon from '@mui/icons-material/Expand';
import FilterListIcon from '@mui/icons-material/FilterList';
import HikingIcon from '@mui/icons-material/Hiking';
import PersonSearchIcon from '@mui/icons-material/PersonSearch';
import RefreshIcon from '@mui/icons-material/Refresh';
import UnfoldLessIcon from '@mui/icons-material/UnfoldLess';
import HistoryIcon from '@mui/icons-material/History';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import PersonAddIcon from '@mui/icons-material/PersonAdd';
import FullUserViewModal from '@client/app/components/admin/Users/Views/FullUserViewModal';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import CreateUserModal, { useCreateUserModal } from './CreateUserModal';
import {
  Badge,
  Button,
  Card,
  Box,
  FormControl,
  IconButton,
  Input,
  LinearProgress,
  Select,
  Option,
  Sheet,
  Stack,
  Typography,
  Dropdown,
  MenuButton,
  Menu,
  MenuItem,
  Checkbox,
  RadioGroup,
  Radio,
} from '@mui/joy';
import React, { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AdminProfileModal from '../AdminProfileModal';
import ComplianceModal from './ComplianceModal';
import { FullUsersView } from './Views/FullUsersView';
import SlimUsersContainer from './Views/SlimUsersView';
import UserJourney from './Views/UserJourney';
import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { useShallow } from 'zustand/react/shallow';
import DownloadIcon from '@mui/icons-material/Download';
import RecentActivityView from './Views/RecentActivityView';
import { PREDEFINED_USER_TAGS } from '@bike4mind/common';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';

const PAGE_LIMIT_OPTIONS = [5, 10, 20];

export type EditedFieldsType = {
  [userId: string]: {
    name?: boolean;
    username?: boolean;
    email?: boolean;
    password?: boolean;
    isAdmin?: boolean;
    isBanned?: boolean;
    isModerated?: boolean;
    subscribedUntil?: boolean;
    userLevel?: boolean;
    userTags?: boolean;
    storageLimit?: boolean;
    currentCredits?: boolean;
    referralAvailable?: boolean;
  };
};

const useUsersTab = create<{
  params: IGetUsersParams;
  setParams: (params: Partial<IGetUsersParams>) => void;
}>()(
  persist(
    (set, get) => ({
      params: {
        page: 1,
        limit: 10,
        search: '',
        sortField: 'createdAt',
        sortOrder: 'desc',
        orgSearch: ['all'],
        tags: [],
      },
      setParams: params => set({ params: { ...get().params, ...params } }),
    }),
    { name: 'admin-user-tab-01' }
  )
);

const PaginationControls: React.FC<{
  currentPage: number;
  totalPages: number;
  maxPage: number;
  onPageChange: (page: number) => void;
  currentLimit: number;
  onLimitChange: (limit: number) => void;
  totalUsers: number;
  pageLimitOptions: number[];
}> = ({
  currentPage,
  totalPages,
  maxPage,
  onPageChange,
  currentLimit,
  onLimitChange,
  totalUsers,
  pageLimitOptions,
}) => (
  <Stack
    direction="row"
    justifyContent="space-between"
    alignItems="center"
    sx={{ my: { xs: 0.5, sm: 1 } }}
    width="100%"
  >
    <Stack direction="row" spacing={{ xs: 1, sm: 2 }} justifyContent="center" alignItems="center">
      <Button size="sm" disabled={currentPage <= 1} onClick={() => onPageChange(currentPage - 1)}>
        Previous
      </Button>
      <Typography level="body-xs" sx={{ display: { sm: 'none' } }}>
        {currentPage}/{totalPages}
      </Typography>
      <Typography level="title-sm" sx={{ display: { xs: 'none', sm: 'block' } }}>
        Page {currentPage} of {totalPages}
      </Typography>
      <Button
        size="sm"
        disabled={currentPage >= maxPage || maxPage === 0}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </Button>
    </Stack>

    {/* Mobile: compact Select for page size */}
    <Stack
      direction="row"
      spacing={1}
      alignItems="center"
      justifyContent="flex-end"
      sx={{ display: { xs: 'flex', sm: 'none' } }}
    >
      <Select
        size="sm"
        value={currentLimit}
        onChange={(_, value) => {
          if (value) onLimitChange(value);
        }}
        sx={{ minWidth: 70 }}
      >
        {pageLimitOptions.map(limit => (
          <Option key={limit} value={limit}>
            {limit}
          </Option>
        ))}
      </Select>
    </Stack>

    {/* Desktop: RadioGroup for page size */}
    <Stack
      direction="row"
      spacing={2}
      alignItems="center"
      justifyContent="flex-end"
      sx={{ display: { xs: 'none', sm: 'flex' } }}
    >
      <FormControl>
        <RadioGroup orientation="horizontal" value={currentLimit} onChange={e => onLimitChange(Number(e.target.value))}>
          {pageLimitOptions.map(limit => (
            <Radio key={limit} value={limit} label={`${limit} per page`} size="sm" sx={{ mr: 2, p: 0.5 }} />
          ))}
        </RadioGroup>
      </FormControl>
      <Typography level="title-sm" fontWeight={800}>
        Total Users: {totalUsers}
      </Typography>
    </Stack>
  </Stack>
);

const UsersTab: React.FC = () => {
  const [displayMode, setDisplayMode] = useState<'full' | 'slim' | 'userJourney' | 'recentActivity'>('slim');
  const [showFilters, setShowFilters] = useState(false);
  const organizations = useGetAllOrganizations({ filters: { personal: false } });
  const userTags = useGetUserTags();
  const { setOpen: setCreateUserModalOpen } = useCreateUserModal();

  const [totalUsers, setTotalUsers] = useState<number>(1);
  const { value: search, debouncedValue: debouncedSearch, setValue: setSearch } = useDebounceValue('');

  const [params, setParams] = useUsersTab(useShallow(state => [state.params, state.setParams]));

  const usersQuery = useGetUsers(params);
  const users = useMemo(() => usersQuery.data?.users ?? [], [usersQuery.data]);
  useEffect(() => {
    setTotalUsers(curr => usersQuery?.data?.totalUsers ?? curr);
  }, [usersQuery?.data?.totalUsers, setTotalUsers]);
  // Reset to "All" if no orgs selected or if selected orgs don't exist in available options
  useEffect(() => {
    if (!params.orgSearch || params.orgSearch.length === 0) {
      setParams({ orgSearch: ['all'] });
      return;
    }

    // Check if selected orgs are valid (exist in available orgs or are special values)
    if (organizations.data && !organizations.isLoading) {
      const availableOrgNames = organizations.data.map(org => org.name);
      const specialValues = ['all', 'Unassigned'];
      const hasValidSelection = params.orgSearch.some(
        selected => specialValues.includes(selected) || availableOrgNames.includes(selected)
      );

      if (!hasValidSelection) {
        setParams({ orgSearch: ['all'] });
      }
    }
  }, [params.orgSearch, organizations.data, organizations.isLoading, setParams]);

  // Update the search parameter in params only when the debounced search value changes
  useEffect(() => {
    if (debouncedSearch === params.search) return;

    setParams({ ...params, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, params, setParams]);

  const handleDownloadCSV = async () => {
    const downloadParams = {
      ...params,
      downloadAll: true,
      page: 1,
      limit: 1000000, // Set a high limit to ensure all users are fetched
    };

    const allUsersData = await fetchUsers(downloadParams);
    const users = allUsersData.users;

    console.log('All users', users);

    const convertToCSV = (users: any[]) => {
      const headers = [
        'Name',
        'Organization',
        'Username',
        'Email',
        'Logins',
        'Last Login',
        'Created At',
        'Is Admin',
        'Is Banned',
      ];
      const rows = users.map(
        (user: {
          name: any;
          organization?: { name: string };
          username: any;
          email: any;
          numLogins: any;
          loginRecords: any;
          createdAt: any;
          isAdmin: any;
          isBanned: any;
        }) => [
          user.name,
          user.organization?.name,
          user.username,
          user.email,
          user.loginRecords.length,
          user.loginRecords?.length > 0 ? user.loginRecords[0].loginTime : 'N/A',
          user.createdAt,
          user.isAdmin ? 'Yes' : 'No',
          user.isBanned ? 'Yes' : 'No',
        ]
      );
      return [headers, ...rows].map(row => row.join(',')).join('\n');
    };

    const csvData = convertToCSV(users);

    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });

    const link = document.createElement('a');
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', 'users.csv');
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const handleOrgSearchChange = (selectedOrgs: string[]) => {
    console.log('selectedOrgs', selectedOrgs);

    if (selectedOrgs.length === 0) {
      setParams({ orgSearch: [], page: 1 });
    } else {
      setParams({ orgSearch: selectedOrgs, page: 1 });
    }
  };

  const toggleOrganization = (orgName: string) => {
    const currentSelection = params.orgSearch || [];

    if (orgName === 'all') {
      // If "all" is clicked, either select all or deselect all
      if (currentSelection.includes('all')) {
        handleOrgSearchChange([]);
      } else {
        handleOrgSearchChange(['all']);
      }
    } else {
      const withoutAll = currentSelection.filter(org => org !== 'all');

      if (currentSelection.includes(orgName)) {
        handleOrgSearchChange(withoutAll.filter(org => org !== orgName));
      } else {
        handleOrgSearchChange([...withoutAll, orgName]);
      }
    }
  };

  const toggleTag = (tagName: string) => {
    const currentTags = params.tags || [];

    if (currentTags.includes(tagName)) {
      setParams({ tags: currentTags.filter(tag => tag !== tagName), page: 1 });
    } else {
      setParams({ tags: [...currentTags, tagName], page: 1 });
    }
  };

  const getDisplayLabel = () => {
    const selected = params.orgSearch || [];
    if (selected.length === 0 || selected.includes('all')) {
      return 'All Organizations';
    }
    if (selected.length === 1) {
      return selected[0];
    }
    return `${selected.length} Selected`;
  };

  const getTagsDisplayLabel = (selectedTags: string[]): string => {
    if (selectedTags.length === 0) return 'All Tags';
    if (selectedTags.length === 1) return selectedTags[0];
    return `${selectedTags.length} tags selected`;
  };

  const availableTags = useMemo(() => {
    const apiTags = userTags.data || [];
    return Array.from(new Set(['Admin', ...PREDEFINED_USER_TAGS, ...apiTags]));
  }, [userTags.data]);

  const handleToggleSortOrder = () => {
    setParams({ ...params, sortOrder: params.sortOrder === 'asc' ? 'desc' : 'asc', page: 1 });
  };

  const handleSearchTermChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    event.preventDefault();
    setSearch(event.target.value);
  };

  const loading = useMemo(
    () => usersQuery.isLoading || usersQuery.isFetching,
    [usersQuery.isLoading, usersQuery.isFetching]
  );

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (params.orgSearch && !params.orgSearch.includes('all') && params.orgSearch.length > 0) count++;
    if (params.tags && params.tags.length > 0) count++;
    if (params.sortField !== 'createdAt' || params.sortOrder !== 'desc') count++;
    return count;
  }, [params.orgSearch, params.tags, params.sortField, params.sortOrder]);

  return (
    <Sheet
      sx={{
        overflow: 'hidden',
        width: '100%',
        px: { xs: 1, sm: 2 },
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ flexShrink: 0 }}>
        <Stack direction="column" justifyContent={'center'} spacing={1} sx={{ width: '100%' }}>
          <Stack direction="column" spacing={1} sx={{ mb: { xs: 1, sm: 3 }, pt: { xs: 0.5, sm: 1 } }}>
            <Card sx={{ px: { xs: 1, sm: 2 }, py: { xs: 0.5, sm: 1 } }}>
              <Stack spacing={1}>
                {/* Always-visible row: Search + View Mode + mobile filter toggle */}
                <Stack direction="row" spacing={1} alignItems="end">
                  <FormControl sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      level="title-sm"
                      sx={{ fontWeight: 500, mb: 0.5, display: { xs: 'none', sm: 'block' } }}
                    >
                      Search Users
                    </Typography>
                    <Input
                      data-testid="admin-search-users-input"
                      size="sm"
                      startDecorator={<PersonSearchIcon />}
                      placeholder="Search users"
                      value={search}
                      onChange={handleSearchTermChange}
                    />
                  </FormControl>

                  <FormControl sx={{ minWidth: { xs: 'auto', sm: 180 }, flexShrink: 0 }}>
                    <Typography
                      level="title-sm"
                      sx={{ fontWeight: 500, mb: 0.5, display: { xs: 'none', sm: 'block' } }}
                    >
                      View Mode
                    </Typography>
                    <Select
                      size="sm"
                      value={displayMode}
                      onChange={(_, value) => {
                        if (value) {
                          setDisplayMode(value as 'full' | 'slim' | 'userJourney' | 'recentActivity');
                        }
                      }}
                      disabled={loading}
                      sx={{ '& .MuiSelect-button': { minWidth: { xs: 0 } } }}
                      renderValue={option => (
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          {option?.value === 'slim' && <UnfoldLessIcon fontSize="small" />}
                          {option?.value === 'full' && <ExpandIcon fontSize="small" />}
                          {option?.value === 'userJourney' && <HikingIcon fontSize="small" />}
                          {option?.value === 'recentActivity' && <HistoryIcon fontSize="small" />}
                          <Box component="span" sx={{ fontSize: { xs: 'xs', sm: 'sm' } }}>
                            {option?.label}
                          </Box>
                        </Box>
                      )}
                    >
                      <Option value="slim">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <UnfoldLessIcon fontSize="small" />
                          Slim
                        </Box>
                      </Option>
                      <Option value="full">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <ExpandIcon fontSize="small" />
                          Full
                        </Box>
                      </Option>
                      <Option value="userJourney">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <HikingIcon fontSize="small" />
                          User Journey
                        </Box>
                      </Option>
                      <Option value="recentActivity">
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <HistoryIcon fontSize="small" />
                          Recent Activity
                        </Box>
                      </Option>
                    </Select>
                  </FormControl>

                  {/* Mobile filter toggle */}
                  <IconButton
                    data-testid="admin-users-filter-toggle"
                    variant={showFilters ? 'soft' : 'plain'}
                    color={activeFilterCount > 0 ? 'primary' : 'neutral'}
                    onClick={() => setShowFilters(prev => !prev)}
                    sx={{ display: { xs: 'flex', sm: 'none' }, flexShrink: 0 }}
                  >
                    <Badge
                      badgeContent={activeFilterCount}
                      badgeInset="14%"
                      size="sm"
                      invisible={activeFilterCount === 0}
                    >
                      <FilterListIcon />
                    </Badge>
                  </IconButton>
                </Stack>

                {/* Collapsible filters: hidden on mobile by default, always visible on sm+ */}
                <Box sx={{ display: { xs: showFilters ? 'block' : 'none', sm: 'block' } }}>
                  <Stack spacing={1}>
                    <Stack
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={2}
                      alignItems={{ xs: 'stretch', sm: 'end' }}
                    >
                      {/* Organizations */}
                      <FormControl sx={{ minWidth: { xs: '100%', sm: 200 } }}>
                        <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                          Organizations
                        </Typography>
                        <Dropdown>
                          <MenuButton
                            disabled={loading}
                            endDecorator={<KeyboardArrowDownIcon />}
                            sx={{
                              minWidth: { xs: '100%', sm: 200 },
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
                                maxWidth: '150px',
                              }}
                            >
                              {getDisplayLabel()}
                            </Box>
                          </MenuButton>
                          <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 300 }}>
                            <MenuItem onClick={() => toggleOrganization('all')}>
                              <Checkbox
                                checked={(params.orgSearch || []).includes('all')}
                                onChange={() => toggleOrganization('all')}
                                sx={{ mr: 1 }}
                              />
                              All
                            </MenuItem>
                            <MenuItem onClick={() => toggleOrganization('Unassigned')}>
                              <Checkbox
                                checked={(params.orgSearch || []).includes('Unassigned')}
                                onChange={() => toggleOrganization('Unassigned')}
                                sx={{ mr: 1 }}
                              />
                              Unassigned
                            </MenuItem>
                            {organizations.data?.map(org => (
                              <MenuItem key={org.id} onClick={() => toggleOrganization(org.name)}>
                                <Checkbox
                                  checked={(params.orgSearch || []).includes(org.name)}
                                  onChange={() => toggleOrganization(org.name)}
                                  sx={{ mr: 1 }}
                                />
                                {org.name}
                              </MenuItem>
                            ))}
                          </Menu>
                        </Dropdown>
                      </FormControl>

                      <Box sx={{ minWidth: { xs: '100%', sm: 180 } }}>
                        <Typography level="title-sm" sx={{ fontWeight: 500, mb: 0.5 }}>
                          User Tags
                        </Typography>
                        <Dropdown>
                          <MenuButton
                            disabled={loading}
                            endDecorator={<KeyboardArrowDownIcon />}
                            sx={{
                              minWidth: { xs: '100%', sm: 180 },
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
                                maxWidth: '120px',
                              }}
                            >
                              {getTagsDisplayLabel(params.tags || [])}
                            </Box>
                          </MenuButton>
                          <Menu sx={{ maxHeight: 300, overflowY: 'auto', minWidth: 200 }}>
                            {availableTags.map(tag => (
                              <MenuItem key={tag} onClick={() => toggleTag(tag)}>
                                <Checkbox
                                  checked={(params.tags || []).includes(tag)}
                                  onChange={() => toggleTag(tag)}
                                  sx={{ mr: 1 }}
                                />
                                {tag}
                              </MenuItem>
                            ))}
                          </Menu>
                        </Dropdown>
                      </Box>
                    </Stack>

                    <Stack
                      direction={{ xs: 'column', md: 'row' }}
                      spacing={2}
                      alignItems={{ xs: 'stretch', md: 'end' }}
                      justifyContent="space-between"
                    >
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={2}
                        alignItems={{ xs: 'stretch', sm: 'center' }}
                      >
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography level="title-sm" sx={{ fontWeight: 500, minWidth: 'max-content' }}>
                            Sort By:
                          </Typography>
                          <Select
                            data-testid="admin-sort-by-select"
                            slotProps={{ listbox: { 'data-testid': 'admin-sort-by-listbox' } }}
                            value={params.sortField}
                            onChange={(_, value) => {
                              if (value) {
                                setParams({ ...params, sortField: value, page: 1 });
                              }
                            }}
                            disabled={loading}
                            sx={{ minWidth: 120 }}
                          >
                            <Option value="createdAt" data-testid="sort-option-created-at">
                              Created At
                            </Option>
                            <Option value="name" data-testid="sort-option-name">
                              Name
                            </Option>
                          </Select>
                        </Stack>

                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography level="title-sm" sx={{ fontWeight: 500, minWidth: 'max-content' }}>
                            Order:
                          </Typography>
                          <Button
                            data-testid="admin-sort-order-btn"
                            variant="outlined"
                            onClick={handleToggleSortOrder}
                            disabled={loading}
                          >
                            {params.sortOrder === 'asc' ? 'A → Z' : 'Z → A'}
                          </Button>
                        </Stack>
                      </Stack>

                      {/* Action Buttons Group */}
                      <Stack
                        direction={{ xs: 'column', md: 'row' }}
                        spacing={1}
                        sx={{
                          minWidth: { xs: '100%', md: 'auto' },
                          justifyContent: { xs: 'stretch', md: 'flex-end' },
                        }}
                      >
                        <Button
                          data-testid="admin-create-user-btn"
                          startDecorator={<PersonAddIcon />}
                          onClick={() => setCreateUserModalOpen(true)}
                          color="primary"
                          sx={{ minWidth: { xs: '100%', md: 'auto' } }}
                        >
                          Create User
                        </Button>
                        <Button
                          data-testid="admin-refresh-btn"
                          disabled={loading}
                          startDecorator={<RefreshIcon />}
                          onClick={() => usersQuery.refetch()}
                          sx={{ minWidth: { xs: '100%', md: 'auto' } }}
                        >
                          Refresh
                        </Button>
                        <Button
                          data-testid="admin-download-csv-btn"
                          disabled={loading || users.length === 0}
                          startDecorator={<DownloadIcon />}
                          onClick={handleDownloadCSV}
                          color="success"
                          sx={{ minWidth: { xs: '100%', md: 'auto' } }}
                        >
                          Download
                        </Button>
                        <ContextHelpButton
                          helpId="admin/user-management"
                          tooltipText="User Management Help"
                          data-testid="admin-help-btn"
                        />
                      </Stack>
                    </Stack>
                  </Stack>
                </Box>
              </Stack>
            </Card>
          </Stack>
        </Stack>

        {/* Top pagination - desktop only */}
        <Box sx={{ display: { xs: 'none', sm: 'block' } }}>
          <PaginationControls
            currentPage={params.page}
            totalPages={usersQuery.data?.totalPages ?? 0}
            maxPage={usersQuery.data?.totalPages ?? 0}
            onPageChange={p => setParams({ ...params, page: p })}
            currentLimit={params.limit}
            onLimitChange={l => setParams({ ...params, limit: l, page: 1 })}
            totalUsers={totalUsers}
            pageLimitOptions={PAGE_LIMIT_OPTIONS}
          />
        </Box>

        {loading && (
          <LinearProgress
            data-testid="admin-users-loading-indicator"
            size={'lg'}
            sx={{ marginX: '5px', width: '100%' }}
          />
        )}
      </Box>

      {!usersQuery.isLoading && (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', mt: 0.5 }}>
          {displayMode === 'full' &&
            users.map((user, index) => <FullUsersView user={user} index={index} key={user.id} />)}

          {displayMode === 'slim' && <SlimUsersContainer users={users} />}

          {displayMode === 'userJourney' &&
            users.map((user, index) => <UserJourney user={user} index={index} key={user.id} />)}

          {displayMode === 'recentActivity' && <RecentActivityView />}
        </Box>
      )}

      <Box sx={{ flexShrink: 0 }}>
        <PaginationControls
          currentPage={params.page}
          totalPages={usersQuery.data?.totalPages ?? 0}
          maxPage={usersQuery.data?.totalPages ?? 0}
          onPageChange={p => setParams({ ...params, page: p })}
          currentLimit={params.limit}
          onLimitChange={l => setParams({ ...params, limit: l, page: 1 })}
          totalUsers={totalUsers}
          pageLimitOptions={PAGE_LIMIT_OPTIONS}
        />
      </Box>

      {/* Place all modals in one area */}
      <AdminProfileModal />
      <ComplianceModal />
      <FullUserViewModal />
      <CreateUserModal />
    </Sheet>
  );
};

export default UsersTab;
