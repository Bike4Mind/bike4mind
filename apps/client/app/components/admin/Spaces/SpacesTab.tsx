import React, { useEffect, useState } from 'react';
import { Button, MenuItem, Stack, Typography } from '@mui/joy';
import { useAdminSpaces, type AdminSpaceRow } from '@client/app/hooks/data/adminSpaces';
import { AdminPageHeader, AdminSearchInput, DataTable, EmptyState } from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { RowActionsMenu } from '../shared/RowActionsMenu';
import SpaceAdminModal from './SpaceAdminModal';
import { type SpacesSortField } from './spacesTabSearch';
import { useOpenSpaceId, useSpacesView } from './useSpacesTabParams';

const SORT_DIRECTION: Record<SpacesSortField, 'asc' | 'desc'> = { createdAt: 'desc', name: 'asc' };

const SEARCH_DEBOUNCE_MS = 300;

const ownerLabel = (owner: AdminSpaceRow['owner']) => owner.email ?? owner.username ?? owner.id;

const SpacesTab: React.FC = () => {
  const [view, setView] = useSpacesView();
  const { setSpaceId } = useOpenSpaceId();
  // The search text stays in component state: it may be an email, and these URLs get shared.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [search]);
  const querySearch = search === '' ? '' : debouncedSearch;

  const { data, isLoading, isError, refetch } = useAdminSpaces({ ...view, search: querySearch });
  const rows = data?.spaces ?? [];
  const total = data?.total ?? 0;

  const handleSearchChange = (value: string) => {
    setSearch(value);
    setView({ page: 1 });
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} data-testid="admin-spaces-tab">
      <AdminPageHeader
        title="Spaces"
        count={isError ? undefined : total}
        description="Find any Space, see its members and domains, remove a member or delete the Space."
      />
      <Stack direction="row" flexWrap="wrap" alignItems="center" gap={1} data-testid="admin-filter-bar">
        <AdminSearchInput
          value={search}
          onChange={handleSearchChange}
          label="Search by name, owner email or username"
          data-testid="admin-spaces-search-input"
        />
      </Stack>
      <DataTable
        label="Spaces"
        rows={isError ? [] : rows}
        getRowId={space => space.id}
        rowTestId={space => `admin-space-row-${space.id}`}
        columns={[
          {
            id: 'name',
            label: 'Name',
            sortable: true,
            render: space => <Typography level="body-sm">{space.name}</Typography>,
          },
          { id: 'owner', label: 'Owner', render: space => ownerLabel(space.owner) },
          { id: 'members', label: 'Members', numeric: true, render: space => space.memberCount },
          { id: 'domains', label: 'Domains', numeric: true, render: space => space.domainCount },
          {
            id: 'createdAt',
            label: 'Created',
            sortable: true,
            render: space => new Date(space.createdAt).toLocaleDateString(),
          },
        ]}
        onRowActivate={space => void setSpaceId(space.id)}
        rowActions={space => (
          <RowActionsMenu testId={`admin-space-actions-${space.id}`} ariaLabel={`Actions for ${space.name}`}>
            <MenuItem onClick={() => void setSpaceId(space.id)} data-testid={`admin-space-open-${space.id}`}>
              View details
            </MenuItem>
          </RowActionsMenu>
        )}
        sort={{ columnId: view.sort, direction: SORT_DIRECTION[view.sort] }}
        onSortChange={sort => setView({ sort: sort.columnId === 'name' ? 'name' : 'createdAt', page: 1 })}
        pagination={{
          page: view.page,
          pageSize: view.limit,
          total,
          onPageChange: page => setView({ page }),
          onPageSizeChange: limit => setView({ limit, page: 1 }),
        }}
        loading={isLoading}
        error={isError ? 'Spaces could not be loaded.' : undefined}
        onRetry={() => void refetch()}
        empty={
          <EmptyState
            title={querySearch ? 'No Spaces match this search' : 'No Spaces yet'}
            action={
              querySearch ? (
                <Button variant="outlined" onClick={() => setSearch('')} data-testid="admin-spaces-empty-clear-btn">
                  Clear search
                </Button>
              ) : null
            }
          />
        }
        minWidth="44rem"
      />
      <SpaceAdminModal />
    </Stack>
  );
};

export default SpacesTab;
