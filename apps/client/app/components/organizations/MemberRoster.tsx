import { IOrganizationDocument } from '@bike4mind/common';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { removedMembersMessage, useRemoveMemberFromOrganization } from '@client/app/hooks/data/organizations';
import { visuallyHidden } from '@client/app/utils/a11yStyles';
import { getErrorMessage } from '@client/app/utils/error';
import SearchIcon from '@mui/icons-material/Search';
import SortIcon from '@mui/icons-material/Sort';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import {
  Box,
  Button,
  Checkbox,
  CircularProgress,
  IconButton,
  Input,
  Option,
  Select,
  Stack,
  Typography,
} from '@mui/joy';
import debounce from 'lodash/debounce';
import { FC, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import OrganizationUserCard, { OrganizationRosterRow } from './UserCard';
import {
  filterMembers,
  MEMBER_ROLES,
  paginate,
  REMOVE_MEMBER_EFFECT,
  RoleFilter,
  rosterGridColumns,
  RosterSortKey,
  SortDirection,
  sortMembers,
  StatusFilter,
} from './memberRosterView';

/** Names listed in the bulk-remove confirmation before it summarises the rest as a count. */
const BULK_NAMES_SHOWN = 10;

const membersLabel = (count: number) => `${count} ${count === 1 ? 'member' : 'members'}`;

interface MemberRosterProps {
  organization: IOrganizationDocument;
  members: OrganizationRosterRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  currentUserId: string | undefined;
  canInviteMembers: boolean;
  /** Coarse flag (`canAdministerOrganization`): whether the roster has a selection column at all. */
  canRevokeMembers: boolean;
  /** Per-target gate (`canRevokeOrgMember`), which also depends on who is being removed. */
  canRevokeMember: (userId: string) => boolean;
  canManageCreditBudgets: boolean;
  canManageManagers: boolean;
}

const MemberRoster: FC<MemberRosterProps> = ({
  organization,
  members,
  isLoading,
  isError,
  onRetry,
  currentUserId,
  canInviteMembers,
  canRevokeMembers,
  canRevokeMember,
  canManageCreditBudgets,
  canManageManagers,
}) => {
  const { t } = useTranslation();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sortKey, setSortKey] = useState<RosterSortKey>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const confirm = useConfirmation();
  const { mutateAsync: removeMember } = useRemoveMemberFromOrganization();

  // Search and filter changes reset selection; sorting and paging retain cross-page selection.
  const resetView = () => {
    setPage(1);
    setSelectedIds(new Set());
  };
  const debouncedSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
        setPage(1);
        setSelectedIds(new Set());
      }, 300),
    []
  );
  useEffect(() => () => debouncedSearch.cancel(), [debouncedSearch]);

  const visible = useMemo(
    () => sortMembers(filterMembers(members, { search, role, status }), sortKey, sortDirection),
    [members, search, role, status, sortKey, sortDirection]
  );
  const current = useMemo(() => paginate(visible, page), [visible, page]);

  const isRemovable = (member: OrganizationRosterRow) =>
    member.status === 'accepted' &&
    member.role !== 'owner' &&
    member.id !== currentUserId &&
    canRevokeMember(member.id);
  const pageRemovable = current.items.filter(isRemovable);
  const allOnPageSelected = pageRemovable.length > 0 && pageRemovable.every(m => selectedIds.has(m.id));
  const someOnPageSelected = pageRemovable.some(m => selectedIds.has(m.id));
  const selectedMembers = useMemo(() => members.filter(m => selectedIds.has(m.id)), [members, selectedIds]);

  const toggleOne = (id: string) =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const togglePage = () =>
    setSelectedIds(prev => {
      const next = new Set(prev);
      for (const member of pageRemovable) {
        if (allOnPageSelected) next.delete(member.id);
        else next.add(member.id);
      }
      return next;
    });

  const clearFilters = () => {
    debouncedSearch.cancel();
    setSearchInput('');
    setSearch('');
    setRole('all');
    setStatus('all');
    resetView();
  };

  const handleRemoveSelected = () => {
    const targets = selectedMembers;
    const label = membersLabel(targets.length);
    confirm({
      title: `Remove ${label}`,
      description: (
        <Stack spacing={1} data-testid="organization-members-bulk-remove-description">
          <Typography level="body-sm">
            Remove these {label} from this team? {REMOVE_MEMBER_EFFECT}
          </Typography>
          <Box component="ul" sx={{ m: 0, pl: 2 }}>
            {targets.slice(0, BULK_NAMES_SHOWN).map(member => (
              <li key={member.id}>{member.name}</li>
            ))}
          </Box>
          {targets.length > BULK_NAMES_SHOWN && (
            <Typography level="body-sm">and {targets.length - BULK_NAMES_SHOWN} more</Typography>
          )}
        </Stack>
      ),
      type: 'danger',
      okLabel: `Remove ${label}`,
      onOk: async () => {
        const kept: (number | null | undefined)[] = [];
        const failed: string[] = [];
        // One at a time: each removal is its own transaction on the server, and a burst of them
        // would contend on the same organization document.
        for (const member of targets) {
          try {
            kept.push(await removeMember({ organizationId: organization.id, userId: member.id, quiet: true }));
          } catch (error) {
            failed.push(`${member.name} (${getErrorMessage(error)})`);
          }
        }
        setSelectedIds(new Set());
        if (kept.length) toast.success(removedMembersMessage(kept));
        if (failed.length) toast.error(`Could not remove ${failed.join(', ')}`);
      },
    });
  };

  const selectOption = (control: string, value: string, label: string) => (
    <Option key={value} value={value} data-testid={`organization-members-${control}-option-${value}`}>
      {label}
    </Option>
  );

  const renderList = () => {
    if (isLoading) {
      return (
        <Stack
          role="status"
          aria-label="Loading members"
          alignItems="center"
          py={4}
          data-testid="organization-members-loading"
        >
          <CircularProgress size="sm" />
        </Stack>
      );
    }
    if (isError) {
      return (
        <Stack spacing={1} alignItems="center" py={4} data-testid="organization-members-error">
          <Typography color="danger">Members could not be loaded.</Typography>
          <Button size="sm" variant="outlined" onClick={onRetry} data-testid="organization-members-retry-btn">
            Try again
          </Button>
        </Stack>
      );
    }
    if (members.length === 0) {
      return (
        <Typography level="body-sm" textAlign="center" py={4} data-testid="organization-members-empty">
          This team has no members yet.
        </Typography>
      );
    }
    if (visible.length === 0) {
      return (
        <Stack spacing={1} alignItems="center" py={4} data-testid="organization-members-no-match">
          <Typography level="body-sm">No members match your search or filters.</Typography>
          <Button size="sm" variant="plain" onClick={clearFilters} data-testid="organization-members-clear-filters-btn">
            Clear filters
          </Button>
        </Stack>
      );
    }
    return current.items.map(member => (
      <OrganizationUserCard
        key={member.id}
        organization={organization}
        user={member}
        canInviteMembers={canInviteMembers}
        canRevokeMembers={canRevokeMember(member.id)}
        canManageCreditBudgets={canManageCreditBudgets}
        canManageManagers={canManageManagers}
        selectable={canRevokeMembers}
        selected={selectedIds.has(member.id)}
        onToggleSelect={isRemovable(member) ? () => toggleOne(member.id) : undefined}
      />
    ));
  };

  return (
    <Stack spacing={1.5} flexGrow={1} mx={{ xs: 0, sm: '20px' }} minHeight={0}>
      <Input
        className="organization-members-search-input"
        placeholder="Search by name or email"
        value={searchInput}
        slotProps={{
          input: {
            'data-testid': 'organization-members-search-input',
            'aria-label': 'Search members by name or email',
          },
        }}
        onChange={e => {
          setSearchInput(e.target.value);
          debouncedSearch(e.target.value);
        }}
        startDecorator={<SearchIcon sx={{ width: '20px', height: '20px' }} />}
      />
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
        <Select
          size="sm"
          value={role}
          onChange={(_e, value) => {
            setRole(value as RoleFilter);
            resetView();
          }}
          slotProps={{ button: { 'aria-label': 'Filter by role', 'data-testid': 'organization-members-role-filter' } }}
        >
          {selectOption('role', 'all', 'All roles')}
          {MEMBER_ROLES.map(key => selectOption('role', key, t(`organization.roles.${key}`)))}
        </Select>
        <Select
          size="sm"
          value={status}
          onChange={(_e, value) => {
            setStatus(value as StatusFilter);
            resetView();
          }}
          slotProps={{
            button: { 'aria-label': 'Filter by status', 'data-testid': 'organization-members-status-filter' },
          }}
        >
          {selectOption('status', 'all', 'All statuses')}
          {selectOption('status', 'accepted', 'Active')}
          {selectOption('status', 'pending', 'Pending')}
        </Select>
        <Select
          size="sm"
          value={sortKey}
          onChange={(_e, value) => {
            setSortKey(value as RosterSortKey);
            setPage(1);
          }}
          slotProps={{ button: { 'aria-label': 'Sort by', 'data-testid': 'organization-members-sort-key' } }}
        >
          {selectOption('sort', 'name', 'Sort by name')}
          {selectOption('sort', 'role', 'Sort by role')}
          {canManageCreditBudgets && selectOption('sort', 'usage', 'Sort by usage')}
        </Select>
        <IconButton
          size="sm"
          variant="outlined"
          data-testid="organization-members-sort-btn"
          aria-label={`Reverse sort order (currently ${sortDirection === 'asc' ? 'ascending' : 'descending'})`}
          onClick={() => setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'))}
        >
          <SortIcon sx={{ transform: sortDirection === 'asc' ? 'scaleY(-1)' : 'none' }} />
        </IconButton>
      </Stack>

      {canRevokeMembers && selectedMembers.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" data-testid="organization-members-bulk-bar">
          <Typography level="body-sm" aria-live="polite">
            {selectedMembers.length} selected
          </Typography>
          <Button
            size="sm"
            color="danger"
            variant="outlined"
            onClick={handleRemoveSelected}
            data-testid="organization-members-remove-selected-btn"
          >
            Remove selected
          </Button>
          <Button size="sm" variant="plain" color="neutral" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </Stack>
      )}

      <Stack className="organization-members-list-container" flexGrow={1} sx={{ overflow: 'auto' }} gap="10px">
        <Box
          className="organization-members-list-header"
          data-testid="organization-members-list-header"
          sx={{
            display: { xs: 'none', sm: 'grid' },
            gridTemplateColumns: rosterGridColumns(canRevokeMembers),
            columnGap: '12px',
            alignItems: 'center',
            borderBottom: '1px solid',
            borderColor: 'divider',
            color: 'text.secondary',
            fontSize: '14px',
            pb: '12px',
            px: '16px',
          }}
        >
          {canRevokeMembers && (
            <Checkbox
              size="sm"
              checked={allOnPageSelected}
              indeterminate={someOnPageSelected && !allOnPageSelected}
              disabled={pageRemovable.length === 0}
              onChange={togglePage}
              slotProps={{
                input: {
                  'aria-label': 'Select all members on this page',
                  'data-testid': 'organization-members-select-all',
                },
              }}
            />
          )}
          <Box>Name</Box>
          <Box>Email</Box>
          <Box>Role</Box>
          <Box sx={{ whiteSpace: 'nowrap' }}>Credits this month</Box>
          <Box>Last active</Box>
          <Box sx={visuallyHidden}>Actions</Box>
        </Box>
        {renderList()}
      </Stack>

      {!isLoading && !isError && visible.length > 0 && (
        <Stack direction="row" spacing={1} alignItems="center" justifyContent="flex-end">
          <Typography level="body-sm" data-testid="organization-members-page-range">
            {current.first}-{current.last} of {visible.length}
          </Typography>
          <IconButton
            size="sm"
            variant="outlined"
            aria-label="Previous page"
            data-testid="organization-members-prev-page-btn"
            disabled={current.page <= 1}
            onClick={() => setPage(current.page - 1)}
          >
            <ChevronLeftIcon />
          </IconButton>
          <Typography level="body-sm">
            Page {current.page} of {current.pageCount}
          </Typography>
          <IconButton
            size="sm"
            variant="outlined"
            aria-label="Next page"
            data-testid="organization-members-next-page-btn"
            disabled={current.page >= current.pageCount}
            onClick={() => setPage(current.page + 1)}
          >
            <ChevronRightIcon />
          </IconButton>
        </Stack>
      )}
    </Stack>
  );
};

export default MemberRoster;
