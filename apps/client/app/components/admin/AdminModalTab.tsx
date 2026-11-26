import React, { useState, useEffect, useMemo } from 'react';
import { Button, ListDivider, MenuItem, Stack, Typography } from '@mui/joy';
import { IModal, IModalDocument } from '@bike4mind/common';
import AddIcon from '@mui/icons-material/Add';

import { deleteModalFromServer, updateModal, createModal } from '@client/app/utils/modalsAPICalls';

import { toast } from 'sonner';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

import GenericModal from '@client/app/components/modals/GenericModal';
import { useGetModals } from '@client/app/hooks/data/modals';
import { useQueryClient } from '@tanstack/react-query';
import { useGetPresignedUrl } from '@client/app/hooks/data/fabFiles';
import { getErrorMessage } from '@client/app/utils/error';

import EditModalNew from './AdminModalTabNew';
import { DeleteModalDialog } from './DeleteModalDialog';
import {
  AdminPageHeader,
  AdminSearchInput,
  DataTable,
  EmptyState,
  RowActionsMenu,
  StatusChip,
  type DataColumn,
} from './shared';
import { ADMIN_REGION_GAP } from './shared/adminStyles';

const modalRowId = (modal: IModalDocument) => modal._id?.toString() ?? '';

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit' });
const toTime = (value?: Date | string) => (value ? new Date(value).getTime() : 0);

const renderDate = (value?: Date | string) => {
  if (!value) return '-';
  const date = new Date(value);
  return (
    <>
      <Typography level="body-sm">{dateFormat.format(date)}</Typography>
      <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
        {timeFormat.format(date)}
      </Typography>
    </>
  );
};

const ellipsis = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

const columns: DataColumn<IModalDocument>[] = [
  {
    id: 'status',
    label: 'Status',
    width: '7rem',
    render: modal => (
      <StatusChip tone={modal.enabled ? 'good' : 'neutral'} label={modal.enabled ? 'Active' : 'Inactive'} />
    ),
  },
  {
    id: 'type',
    label: 'Type',
    width: '6rem',
    sortValue: modal => (modal.isBanner ? 'banner' : 'modal'),
    render: modal => <Typography level="body-sm">{modal.isBanner ? 'Banner' : 'Modal'}</Typography>,
  },
  {
    id: 'title',
    label: 'Title',
    sortValue: modal => (modal.title || '').toLowerCase(),
    render: modal => {
      const secondary = (modal.isBanner ? modal.textMessage : modal.subtitle) || undefined;
      return (
        <>
          <Typography level="body-sm" fontWeight="md" title={modal.title || undefined} sx={ellipsis}>
            {modal.title || '(No title)'}
          </Typography>
          {secondary && (
            <Typography level="body-xs" title={secondary} sx={{ ...ellipsis, color: 'admin.inkMuted' }}>
              {secondary}
            </Typography>
          )}
        </>
      );
    },
  },
  {
    id: 'description',
    label: 'Description',
    width: '11rem',
    render: modal => (
      <Typography level="body-sm" title={modal.description || undefined} sx={{ ...ellipsis, color: 'admin.inkMuted' }}>
        {modal.description}
      </Typography>
    ),
  },
  {
    id: 'targeting',
    label: 'Targeting',
    width: '8rem',
    render: modal => (
      <Typography level="body-sm" sx={ellipsis}>
        {modal.tags?.length ? modal.tags.join(', ') : 'All users'}
      </Typography>
    ),
  },
  {
    id: 'priority',
    label: 'Priority',
    width: '6rem',
    numeric: true,
    sortValue: modal => modal.priority || 0,
    render: modal => modal.priority || 0,
  },
  {
    id: 'createdAt',
    label: 'Created',
    width: '8rem',
    sortValue: modal => toTime(modal.createdAt),
    render: modal => renderDate(modal.createdAt),
  },
  {
    id: 'updatedAt',
    label: 'Updated',
    width: '8rem',
    sortValue: modal => toTime(modal.updatedAt),
    render: modal => renderDate(modal.updatedAt),
  },
];

const ModalsAdminTab: React.FC = () => {
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [currentModal, setCurrentModal] = useState<IModalDocument | null>(null);
  const [previewModalData, setPreviewModalData] = useState<IModal | null>(null);
  const [previewData, setPreviewData] = useState<IModal | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState<boolean>(false);
  const [modalToDelete, setModalToDelete] = useState<IModalDocument | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Exclude What's New modals since they have their own dedicated admin tab
  const modals = useGetModals({ excludeWhatsNew: true });
  const queryClient = useQueryClient();
  const { mutateAsync: getPresignedUrl } = useGetPresignedUrl();

  const filteredModals = useMemo(() => {
    const searchLower = searchQuery.trim().toLowerCase();
    if (!searchLower) return modals.data ?? [];
    return (modals.data ?? []).filter(
      modal =>
        modal.title?.toLowerCase().includes(searchLower) ||
        modal.textMessage?.toLowerCase().includes(searchLower) ||
        modal.description?.toLowerCase().includes(searchLower) ||
        modal.tags?.some(tag => tag.toLowerCase().includes(searchLower))
    );
  }, [modals.data, searchQuery]);

  // Handle async preview data generation
  useEffect(() => {
    const generatePreviewData = async () => {
      if (!previewModalData) {
        setPreviewData(null);
        return;
      }

      try {
        const imageUrl = previewModalData.imageUrl;

        if (imageUrl && imageUrl.includes('amazonaws.com') && !imageUrl.includes('/proxied-images/')) {
          const urlObj = new URL(imageUrl);
          const filePath = urlObj.pathname.startsWith('/') ? urlObj.pathname.substring(1) : urlObj.pathname;
          const [presignedUrl] = await getPresignedUrl({ filePaths: [filePath], expiresIn: 3600 });

          setPreviewData({ ...previewModalData, imageUrl: presignedUrl });
        } else {
          setPreviewData(previewModalData);
        }
      } catch (e) {
        setPreviewData(previewModalData);
      }
    };

    generatePreviewData();
  }, [previewModalData, getPresignedUrl]);

  const handleToggleEnabled = async (modal: IModalDocument) => {
    if (!modal._id) return;
    setTogglingId(modalRowId(modal));
    try {
      await updateModal(modal._id, { ...modal, enabled: !modal.enabled });
      toast.success(modal.enabled ? 'Modal disabled' : 'Modal enabled');
      await queryClient.invalidateQueries({ queryKey: ['modals'] });
    } catch (error) {
      console.error('Error updating modal:', error);
      toast.error('Failed to update modal');
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaveModal = async (modalFields: IModal) => {
    try {
      if (!modalFields.numberOfAgrees?.type || !modalFields.numberOfViews?.type) {
        toast.error('Please setup the number of agrees and number of views counters before creating the modal.');
        return;
      }

      if (currentModal && currentModal._id) {
        await updateModal(currentModal._id, modalFields);
        toast.success('Modal updated successfully');
      } else {
        await createModal(modalFields);
        toast.success('Modal created successfully');
      }

      queryClient.invalidateQueries({ queryKey: ['modals'] });
      setIsEditModalOpen(false);
    } catch (error) {
      console.error('Error saving modal:', error);
      toast.error('Failed to save modal');
    }
  };

  const handleEditClick = (modal: IModalDocument) => {
    setCurrentModal(modal);
    setIsEditModalOpen(true);
  };

  const handlePreviewClick = (modal: IModalDocument) => {
    setPreviewData({ ...modal, imageUrl: '' });
    setPreviewModalData(modal);
    setIsPreviewOpen(true);
  };

  const openCreateModal = () => {
    setCurrentModal(null);
    setIsEditModalOpen(true);
  };

  const handleDeleteConfirmed = async () => {
    if (!modalToDelete?._id) return;
    try {
      await deleteModalFromServer(modalToDelete._id);
    } catch (error) {
      // Keep the dialog open so the admin can retry.
      toast.error(`Failed to delete modal: ${getErrorMessage(error)}`);
      return;
    }
    toast.success('Modal deleted');
    queryClient.invalidateQueries({ queryKey: ['modals'] });
    setModalToDelete(null);
  };

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-modals-tab">
      <AdminPageHeader
        title="Modals"
        count={modals.data?.length}
        description="Modals and banners shown to users in the app. What's New announcements live in their own tab."
        actions={
          <>
            <ContextHelpButton helpId="admin/modals" tooltipText="Modals help" />
            <Button
              size="sm"
              startDecorator={<AddIcon />}
              onClick={openCreateModal}
              data-testid="admin-modals-create-btn"
            >
              Create modal
            </Button>
          </>
        }
      />

      <Stack direction="row" alignItems="center" flexWrap="wrap" gap={1}>
        <AdminSearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          label="Search modals"
          data-testid="admin-modals-search-input"
        />
      </Stack>

      <DataTable
        rows={filteredModals}
        columns={columns}
        getRowId={modalRowId}
        label="Modals"
        testId="admin-modals-table"
        rowTestId={modal => `admin-modals-row-${modalRowId(modal)}`}
        loading={modals.isLoading}
        error={modals.isError && !modals.data ? `Couldn't load modals: ${getErrorMessage(modals.error)}` : undefined}
        onRetry={() => modals.refetch()}
        pageResetKey={searchQuery}
        onRowActivate={handleEditClick}
        minWidth="68rem"
        empty={
          searchQuery.trim() ? (
            <EmptyState
              title="No modals match this search"
              action={
                <Button size="sm" variant="outlined" onClick={() => setSearchQuery('')}>
                  Clear search
                </Button>
              }
            />
          ) : (
            <EmptyState
              title="No modals yet"
              description="Create a modal or banner to show users in the app."
              action={
                <Button size="sm" variant="outlined" startDecorator={<AddIcon />} onClick={openCreateModal}>
                  Create modal
                </Button>
              }
            />
          )
        }
        rowActions={modal => {
          const id = modalRowId(modal);
          return (
            <RowActionsMenu
              testId={`admin-modals-row-actions-${id}`}
              ariaLabel={`Actions for ${modal.title || 'modal'}`}
              loading={togglingId === id}
              stopRowClick
            >
              <MenuItem onClick={() => handleEditClick(modal)} data-testid={`admin-modals-row-edit-${id}`}>
                Edit modal
              </MenuItem>
              <MenuItem onClick={() => handlePreviewClick(modal)} data-testid={`admin-modals-row-preview-${id}`}>
                Preview modal
              </MenuItem>
              <MenuItem onClick={() => handleToggleEnabled(modal)} data-testid={`admin-modals-row-toggle-${id}`}>
                {modal.enabled ? 'Disable modal' : 'Enable modal'}
              </MenuItem>
              <ListDivider />
              <MenuItem
                color="danger"
                onClick={() => setModalToDelete(modal)}
                data-testid={`admin-modals-row-delete-${id}`}
              >
                Delete modal
              </MenuItem>
            </RowActionsMenu>
          );
        }}
      />

      {isEditModalOpen && (
        <EditModalNew
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          modalData={currentModal}
          onSave={handleSaveModal}
          isEditMode={!!currentModal}
        />
      )}

      <DeleteModalDialog
        modal={modalToDelete}
        onClose={() => setModalToDelete(null)}
        onDelete={handleDeleteConfirmed}
        data-testid="admin-modals-delete-dialog"
        confirmTestId="admin-modals-delete-confirm-btn"
      />

      {isPreviewOpen && previewData && (
        <GenericModal
          {...previewData}
          isOpen={isPreviewOpen}
          onAgree={() => setIsPreviewOpen(false)}
          onClose={() => setIsPreviewOpen(false)}
          isPreview={true}
        />
      )}
    </Stack>
  );
};
export default ModalsAdminTab;
