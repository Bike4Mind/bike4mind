import React, { useMemo, useEffect, useState } from 'react';
import { Button, CircularProgress, IconButton, Stack, Tooltip } from '@mui/joy';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CircleIcon from '@mui/icons-material/Circle';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useQueryClient } from '@tanstack/react-query';
import { GRANT_PACKAGES_QUERY_KEY } from '@client/app/utils/grantPackageAPICalls';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { RegInviteStatusType } from '@bike4mind/common';
import {
  useCreateRegInvites,
  useDeleteRegInvites,
  useGetRegInvites,
  useUpdateRegInvites,
} from '@client/app/hooks/data/regInvites';
import { useRegistrationInvitesStore } from './store';
import { RegInviteData, CreateInviteFormData } from './types';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import { BulkActionBar } from '../shared/BulkActionBar';
import { EmptyState } from '../shared/EmptyState';
import { ErrorState } from '../shared/ErrorState';
import { LoadingState } from '../shared/LoadingState';
import { ViewTabs } from '../shared/ViewTabs';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';
import { InviteTable } from './components/InviteTable';
import { CreateInviteModal } from './components/CreateInviteModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';

const BULK_STATUS_ACTIONS = [
  { status: RegInviteStatusType.open, label: 'Set Multiple Open', icon: <CircleIcon /> },
  { status: RegInviteStatusType.waiting, label: 'Set Multiple Waiting', icon: <HourglassBottomIcon /> },
  { status: RegInviteStatusType.used, label: 'Set Multiple Used', icon: <CloseFullscreenIcon /> },
];

const ActionControls: React.FC<{
  onRefetch: () => void;
  isFetching: boolean;
  onOpenCreate: () => void;
}> = ({ onRefetch, isFetching, onOpenCreate }) => {
  const isMobile = useIsMobile();
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <ContextHelpButton helpId="admin/invite-codes" tooltipText="Invite Codes Help" />
      {isMobile ? (
        <>
          <Tooltip title={isFetching ? 'Refreshing...' : 'Refresh'}>
            <IconButton
              data-testid="invite-codes-refresh-btn"
              size="sm"
              variant="outlined"
              onClick={onRefetch}
              disabled={isFetching}
              loading={isFetching}
            >
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Tooltip title="Create Invite">
            <IconButton
              data-testid="invite-create-btn"
              size="sm"
              variant="outlined"
              color="neutral"
              onClick={onOpenCreate}
            >
              <AddCircleOutlineIcon />
            </IconButton>
          </Tooltip>
        </>
      ) : (
        <>
          <Button
            data-testid="invite-codes-refresh-btn"
            size="sm"
            variant="outlined"
            color="neutral"
            startDecorator={<RefreshIcon />}
            onClick={onRefetch}
            disabled={isFetching}
            loading={isFetching}
          >
            {isFetching ? 'Refetching...' : 'Refresh'}
          </Button>
          <Button
            data-testid="invite-create-btn"
            variant="outlined"
            color="neutral"
            size="sm"
            startDecorator={<AddCircleOutlineIcon />}
            onClick={onOpenCreate}
          >
            Create
          </Button>
        </>
      )}
    </Stack>
  );
};

const RegistrationInvitesTab: React.FC = () => {
  const {
    copied,
    setCopied,
    operating,
    setOperating,
    activeTab,
    setActiveTab,
    unusedSelected,
    setUnusedSelected,
    usedSelected,
    setUsedSelected,
    multiSelected,
    setMultiSelected,
    unusedSortDirection,
    usedSortDirection,
    toggleUnusedSortDirection,
    toggleUsedSortDirection,
    setOpenCreate,
    setOpenDeleteWarning,
  } = useRegistrationInvitesStore();

  const queryClient = useQueryClient();
  const query = useGetRegInvites();
  const regInviteCreate = useCreateRegInvites({
    onSuccess: () => {
      setOpenCreate(false);
      query.refetch();
      void queryClient.invalidateQueries({ queryKey: [GRANT_PACKAGES_QUERY_KEY] });
    },
  });
  const regInviteUpdate = useUpdateRegInvites({
    onSuccess: () => {
      query.refetch();
      setOperating(false);
      setUnusedSelected([]);
      setUsedSelected([]);
    },
    onError: () => {
      setOperating(false);
    },
  });
  const regInviteDelete = useDeleteRegInvites({
    onSuccess: () => {
      query.refetch();
      setOperating(false);
      setUnusedSelected([]);
      setUsedSelected([]);
    },
    onError: () => {
      setOperating(false);
    },
  });

  const formatDate = (dateString: Date | string | undefined | null) => {
    if (!dateString) return 'N/A';

    try {
      const date = dateString instanceof Date ? dateString : new Date(dateString);
      return isNaN(date.getTime()) ? 'N/A' : date.toLocaleString();
    } catch {
      return 'N/A';
    }
  };

  const [now] = useState(() => Date.now());

  const sortedInvites = useMemo(() => {
    if (!query?.data || query.data.length === 0) return { unused: [], used: [], availableCount: 0, usedCount: 0 };

    const isAvailable = (invite: RegInviteData) => {
      if (invite.status === RegInviteStatusType.used) return false;
      if (invite.unlimitedUse) {
        if (invite.expiresAt) {
          const expiresAtDate = invite.expiresAt instanceof Date ? invite.expiresAt : new Date(invite.expiresAt);
          if (Number.isNaN(expiresAtDate.getTime())) return false;
          return expiresAtDate.getTime() >= now;
        }
        return true;
      }
      return true;
    };

    const unusedInvites = query.data.filter(invite => isAvailable(invite));
    const usedInvites = query.data.filter(invite => !isAvailable(invite));

    const sortInvites = (invites: RegInviteData[], sortDirection: 'asc' | 'desc') => {
      return [...invites].sort((a, b) => {
        const dateA = a.createdAt ? new Date(a.createdAt).getTime() : null;
        const dateB = b.createdAt ? new Date(b.createdAt).getTime() : null;

        if (dateA && dateB && !isNaN(dateA) && !isNaN(dateB)) {
          return sortDirection === 'desc' ? dateB - dateA : dateA - dateB;
        }

        // Otherwise, fall back to ObjectId timestamps
        try {
          const timestampA = a.id ? parseInt(a.id.substring(0, 8), 16) * 1000 : 0;
          const timestampB = b.id ? parseInt(b.id.substring(0, 8), 16) * 1000 : 0;
          return sortDirection === 'desc' ? timestampB - timestampA : timestampA - timestampB;
        } catch (error) {
          return 0;
        }
      });
    };

    const sortedUnusedInvites = sortInvites(unusedInvites, unusedSortDirection);
    const sortedUsedInvites = sortInvites(usedInvites, usedSortDirection);

    return {
      unused: sortedUnusedInvites,
      used: sortedUsedInvites,
      availableCount: sortedUnusedInvites.length,
      usedCount: sortedUsedInvites.length,
    };
  }, [query.data, unusedSortDirection, usedSortDirection, now]);

  const hasInvites = (query?.data ?? []).length > 0;

  const handleSubmit = async (data: CreateInviteFormData) => {
    try {
      regInviteCreate.mutate(data);
    } catch {
      console.log('Failed to create invites');
    }
  };

  const handleUpdate = async (ids: string[], status: RegInviteStatusType) => {
    setOperating(true);
    try {
      regInviteUpdate.mutate({ ids, status });
    } catch {
      console.log('Failed to update invites');
    }
  };

  const handleDelete = async (ids: string[]) => {
    setOperating(true);
    try {
      regInviteDelete.mutate(ids);
    } catch {
      console.log('Failed to delete invites');
    }
  };

  const handleMultiDelete = () => {
    handleDelete(multiSelected);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(err => {
        console.error('Could not copy text: ', err);
      });
  };

  useEffect(() => {
    if (activeTab === 'available') {
      setMultiSelected(unusedSelected);
    } else {
      setMultiSelected(usedSelected);
    }
  }, [activeTab, unusedSelected, usedSelected, setMultiSelected]);

  const actionControls = (
    <ActionControls
      onRefetch={() => query.refetch()}
      isFetching={query.isFetching}
      onOpenCreate={() => setOpenCreate(true)}
    />
  );
  const createAction = (
    <Button size="sm" onClick={() => setOpenCreate(true)} data-testid="invite-empty-create-btn">
      Create invite
    </Button>
  );
  const isAvailableTab = activeTab === 'available';
  const tabInvites = isAvailableTab ? sortedInvites.unused : sortedInvites.used;
  const setTabSelected = isAvailableTab ? setUnusedSelected : setUsedSelected;
  const tableProps = {
    copyToClipboard,
    handleUpdate,
    handleDelete,
    operating,
    copied,
    formatDate,
  };

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ width: '100%' }}>
      {query.isLoading && <LoadingState label="Loading invites" />}

      {!query.isLoading && query.isError && !hasInvites && (
        <ErrorState
          message="Could not load registration invites."
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      )}

      {!query.isLoading && !query.isError && !hasInvites && (
        <>
          <Stack direction="row" justifyContent="flex-end">
            {actionControls}
          </Stack>
          <EmptyState
            title="No registration invites yet"
            description="Create an invite code to let someone register."
            action={createAction}
          />
        </>
      )}

      {hasInvites && (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
            <ViewTabs
              views={[
                {
                  id: 'available',
                  label: 'Available',
                  count: sortedInvites.availableCount,
                  testId: 'invite-available-tab',
                },
                { id: 'used', label: 'Used', count: sortedInvites.usedCount, testId: 'invite-used-tab' },
              ]}
              activeId={activeTab}
              onSelect={id => setActiveTab(id as 'available' | 'used')}
              aria-label="Invite status"
              data-testid="invite-status-tabs"
            />
            {actionControls}
          </Stack>

          <BulkActionBar
            selection={{ mode: 'explicit', ids: multiSelected }}
            totalMatching={tabInvites.length}
            onSelectAllMatching={() => setTabSelected(tabInvites.map(i => i.id))}
            onClear={() => setTabSelected([])}
          >
            {BULK_STATUS_ACTIONS.map(({ status, label, icon }) => (
              <Tooltip key={status} title={label}>
                <IconButton
                  aria-label={label}
                  variant="outlined"
                  color="neutral"
                  size="sm"
                  disabled={operating}
                  onClick={() => handleUpdate(multiSelected, status)}
                >
                  {icon}
                </IconButton>
              </Tooltip>
            ))}
            <Tooltip title="Delete Multiple">
              <IconButton
                aria-label="Delete Multiple"
                variant="outlined"
                color="neutral"
                size="sm"
                data-testid="invite-bulk-delete-btn"
                onClick={() => setOpenDeleteWarning(true)}
              >
                {operating ? <CircularProgress size="sm" /> : <DeleteForeverIcon />}
              </IconButton>
            </Tooltip>
          </BulkActionBar>

          <InviteTable
            key={activeTab}
            {...tableProps}
            label={isAvailableTab ? 'Available registration invites' : 'Used registration invites'}
            allInvites={tabInvites}
            selected={isAvailableTab ? unusedSelected : usedSelected}
            setSelected={setTabSelected}
            sortDirection={isAvailableTab ? unusedSortDirection : usedSortDirection}
            toggleSortDirection={isAvailableTab ? toggleUnusedSortDirection : toggleUsedSortDirection}
            empty={
              <EmptyState
                title={isAvailableTab ? 'No available registration codes' : 'No used registration codes'}
                action={isAvailableTab ? createAction : null}
              />
            }
          />
        </>
      )}
      <CreateInviteModal onSubmit={handleSubmit} isLoading={regInviteCreate.isPending} />
      <DeleteConfirmModal onConfirm={handleMultiDelete} />
    </Stack>
  );
};

export default RegistrationInvitesTab;
