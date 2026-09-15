import React, { useMemo, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  LinearProgress,
  Sheet,
  Stack,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/joy';
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline';
import CircleIcon from '@mui/icons-material/Circle';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import HourglassBottomIcon from '@mui/icons-material/HourglassBottom';
import RefreshIcon from '@mui/icons-material/Refresh';
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
import PaginationControls from '@client/app/components/admin/Subscriptions/components/PaginationControls';
import { InviteTable } from './components/InviteTable';
import { CreateInviteModal } from './components/CreateInviteModal';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';

const ActionControls: React.FC<{
  multiSelected: string[];
  onUpdate: (ids: string[], status: RegInviteStatusType) => void;
  operating: boolean;
  onOpenDeleteWarning: () => void;
  onRefetch: () => void;
  isFetching: boolean;
  onOpenCreate: () => void;
}> = ({ multiSelected, onUpdate, operating, onOpenDeleteWarning, onRefetch, isFetching, onOpenCreate }) => {
  const isMobile = useIsMobile();
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      {multiSelected.length > 0 && (
        <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '5px' }}>
          <Tooltip color="primary" title="Set Multiple Open">
            <IconButton
              onClick={() => onUpdate(multiSelected, RegInviteStatusType.open)}
              color="primary"
              disabled={operating}
              size="sm"
            >
              <CircleIcon />
            </IconButton>
          </Tooltip>
          <Tooltip color="warning" title="Set Multiple Waiting">
            <IconButton
              onClick={() => onUpdate(multiSelected, RegInviteStatusType.waiting)}
              color="warning"
              disabled={operating}
              size="sm"
            >
              <HourglassBottomIcon />
            </IconButton>
          </Tooltip>
          <Tooltip color="success" title="Set Multiple Used">
            <IconButton
              onClick={() => onUpdate(multiSelected, RegInviteStatusType.used)}
              color="success"
              disabled={operating}
              size="sm"
            >
              <CloseFullscreenIcon />
            </IconButton>
          </Tooltip>
          <Tooltip color="danger" title="Delete Multiple">
            <IconButton color="danger" size="sm" onClick={onOpenDeleteWarning}>
              {operating ? <CircularProgress size="sm" /> : <DeleteForeverIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      )}
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
              variant="solid"
              color="success"
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
            startDecorator={<RefreshIcon />}
            onClick={onRefetch}
            disabled={isFetching}
            loading={isFetching}
          >
            {isFetching ? 'Refetching...' : 'Refresh'}
          </Button>
          <Button
            data-testid="invite-create-btn"
            color="success"
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
    currentPage,
    setCurrentPage,
    itemsPerPage,
    setItemsPerPage,
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

  const query = useGetRegInvites();
  const regInviteCreate = useCreateRegInvites({
    onSuccess: () => {
      setOpenCreate(false);
      query.refetch();
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

  const currentTabData = activeTab === 'available' ? sortedInvites.unused : sortedInvites.used;
  const totalPages = Math.ceil(currentTabData.length / itemsPerPage);
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentItems = currentTabData.slice(indexOfFirstItem, indexOfLastItem);
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

  return (
    <Sheet sx={{ width: '100%', p: '10px' }}>
      {query.isLoading && <LinearProgress />}

      {!query.isLoading && !hasInvites && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ my: 2 }}>
          <Typography level="h3">No Registration Invites found.</Typography>
          <ActionControls
            multiSelected={multiSelected}
            onUpdate={handleUpdate}
            operating={operating}
            onOpenDeleteWarning={() => setOpenDeleteWarning(true)}
            onRefetch={() => query.refetch()}
            isFetching={query.isFetching}
            onOpenCreate={() => setOpenCreate(true)}
          />
        </Stack>
      )}

      {hasInvites && (
        <Tabs value={activeTab} onChange={(_, value) => setActiveTab(value as 'available' | 'used')}>
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <TabList>
              <Tab data-testid="invite-available-tab" value="available">
                Available ({sortedInvites.availableCount})
              </Tab>
              <Tab data-testid="invite-used-tab" value="used">
                Used ({sortedInvites.usedCount})
              </Tab>
            </TabList>
            <ActionControls
              multiSelected={multiSelected}
              onUpdate={handleUpdate}
              operating={operating}
              onOpenDeleteWarning={() => setOpenDeleteWarning(true)}
              onRefetch={() => query.refetch()}
              isFetching={query.isFetching}
              onOpenCreate={() => setOpenCreate(true)}
            />
          </Box>

          <TabPanel value="available" sx={{ px: 0 }}>
            {sortedInvites.unused.length > 0 ? (
              <>
                <PaginationControls
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  totalPages={totalPages}
                  totalItems={sortedInvites.unused.length}
                  itemsPerPage={itemsPerPage}
                  onItemsPerPageChange={setItemsPerPage}
                  showTotal={false}
                  pageLimitOptions={[5, 10, 20]}
                />
                <InviteTable
                  invites={activeTab === 'available' ? currentItems : []}
                  allInvites={sortedInvites.unused}
                  borderColor="#4caf50"
                  selected={unusedSelected}
                  setSelected={setUnusedSelected}
                  sortDirection={unusedSortDirection}
                  toggleSortDirection={toggleUnusedSortDirection}
                  handleUpdate={handleUpdate}
                  handleDelete={handleDelete}
                  copyToClipboard={copyToClipboard}
                  operating={operating}
                  copied={copied}
                  formatDate={formatDate}
                />
                <PaginationControls
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  totalPages={totalPages}
                  totalItems={sortedInvites.unused.length}
                  itemsPerPage={itemsPerPage}
                  onItemsPerPageChange={setItemsPerPage}
                  showTotal={false}
                  pageLimitOptions={[5, 10, 20]}
                />
              </>
            ) : (
              <Typography level="body-md" sx={{ textAlign: 'center', py: 4 }}>
                No available registration codes found.
              </Typography>
            )}
          </TabPanel>

          <TabPanel value="used" sx={{ px: 0 }}>
            {sortedInvites.used.length > 0 ? (
              <>
                <PaginationControls
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  totalPages={totalPages}
                  totalItems={sortedInvites.used.length}
                  itemsPerPage={itemsPerPage}
                  onItemsPerPageChange={setItemsPerPage}
                  showTotal={false}
                  pageLimitOptions={[5, 10, 20]}
                />
                <InviteTable
                  invites={activeTab === 'used' ? currentItems : []}
                  allInvites={sortedInvites.used}
                  borderColor="#9e9e9e"
                  selected={usedSelected}
                  setSelected={setUsedSelected}
                  sortDirection={usedSortDirection}
                  toggleSortDirection={toggleUsedSortDirection}
                  handleUpdate={handleUpdate}
                  handleDelete={handleDelete}
                  copyToClipboard={copyToClipboard}
                  operating={operating}
                  copied={copied}
                  formatDate={formatDate}
                />
                <PaginationControls
                  currentPage={currentPage}
                  onPageChange={setCurrentPage}
                  totalPages={totalPages}
                  totalItems={sortedInvites.used.length}
                  itemsPerPage={itemsPerPage}
                  onItemsPerPageChange={setItemsPerPage}
                  showTotal={false}
                  pageLimitOptions={[5, 10, 20]}
                />
              </>
            ) : (
              <Typography level="body-md" sx={{ textAlign: 'center', py: 4 }}>
                No used registration codes found.
              </Typography>
            )}
          </TabPanel>
        </Tabs>
      )}
      <CreateInviteModal onSubmit={handleSubmit} isLoading={regInviteCreate.isPending} />
      <DeleteConfirmModal onConfirm={handleMultiDelete} />
    </Sheet>
  );
};

export default RegistrationInvitesTab;
