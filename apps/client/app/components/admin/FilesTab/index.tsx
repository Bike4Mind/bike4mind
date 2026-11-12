import EditTagModal, { useEditAppFileTagModal } from '@client/app/components/admin/FilesTab/EditTagModal';
import { IAppFileDocument, IAppFileGetAllApiResponse, KnowledgeType } from '@bike4mind/common';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import {
  Box,
  Button,
  Chip,
  Dropdown,
  IconButton,
  ListDivider,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import FilePondPluginImageExifOrientation from 'filepond-plugin-image-exif-orientation';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import 'filepond/dist/filepond.min.css';
import { FilePond, registerPlugin } from 'react-filepond';
import { toast } from 'sonner';
import prettyBytes from 'pretty-bytes';
import { useCallback, useMemo, useState } from 'react';
import { createAppFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { useGetReports } from '@client/app/hooks/data/appFile';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminPageHeader,
  DataTable,
  EmptyState,
  RelativeTime,
  StatusChip,
  UpdatingBar,
  type DataColumn,
} from '../shared';
import { ADMIN_REGION_GAP } from '../shared/adminStyles';

// any: react-filepond's class component typings do not satisfy the current JSX element type.
const FilePondComponent = FilePond as any;

registerPlugin(FilePondPluginImageExifOrientation, FilePondPluginImagePreview);

// The populated owner is null once the uploader's account is gone; `id` comes from the schema's virtuals.
type AppFileRow = Omit<IAppFileGetAllApiResponse[number], 'userId'> & {
  userId: { id?: string; name: string; email: string } | null;
};

const AdminFilesTab = () => {
  const appFiles = useGetReports();
  const { currentUser } = useUser();
  const setTargetEditTagFile = useEditAppFileTagModal(state => state.setTargetFile);
  useSubscribeCollection<IAppFileDocument>(
    'appfiles',
    useMemo(() => ({}), []),
    useCallback(
      (type: string) => {
        if (type === 'update') appFiles.refetch();
      },
      [appFiles]
    )
  );

  const [deleting, setDeleting] = useState<AppFileRow | null>(null);
  const queryClient = useQueryClient();
  const deleteAppFile = useMutation({
    mutationFn: (id: string) => api.delete(`/api/app-files/delete`, { data: { id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['app-files'] }),
  });

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteAppFile.mutateAsync(deleting.id);
      toast.success('File deleted');
      setDeleting(null);
    } catch {
      toast.error('The file could not be deleted. Try again.');
    }
  };

  const files = (appFiles.data ?? []) as unknown as AppFileRow[];
  // The delete route only removes the caller's own uploads, so the action is offered to the uploader only.
  const canDelete = (file: AppFileRow) => !!currentUser?.id && file.userId?.id === currentUser.id;
  const editTags = (file: AppFileRow) => setTargetEditTagFile(file as unknown as IAppFileDocument);

  const columns: DataColumn<AppFileRow>[] = [
    {
      id: 'name',
      label: 'File',
      sortValue: f => f.name.toLowerCase(),
      render: f => (
        <Stack gap={0.25} sx={{ minWidth: 0 }}>
          <Typography level="body-sm" noWrap title={f.name} sx={{ color: 'admin.ink', fontWeight: 500 }}>
            {f.name}
          </Typography>
          <Typography level="body-xs" noWrap title={f.path} sx={{ color: 'admin.inkMuted', fontFamily: 'code' }}>
            {f.path}
          </Typography>
        </Stack>
      ),
    },
    {
      id: 'size',
      label: 'Size',
      width: '7rem',
      numeric: true,
      sortValue: f => f.size,
      render: f => prettyBytes(f.size),
    },
    {
      id: 'tags',
      label: 'Tags',
      width: '12rem',
      render: f =>
        f.tags?.length ? (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {f.tags.map(tag => (
              <Chip key={tag} size="sm" variant="soft" color="neutral">
                {tag}
              </Chip>
            ))}
          </Box>
        ) : (
          <Box component="span" sx={{ color: 'admin.inkMuted' }}>
            -
          </Box>
        ),
    },
    {
      id: 'owner',
      label: 'Uploaded by',
      width: '12rem',
      sortValue: f => f.userId?.name?.toLowerCase() ?? '',
      render: f =>
        f.userId ? (
          <Stack gap={0.25} sx={{ minWidth: 0 }}>
            <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
              {f.userId.name}
            </Typography>
            <Typography level="body-xs" noWrap title={f.userId.email} sx={{ color: 'admin.inkMuted' }}>
              {f.userId.email}
            </Typography>
          </Stack>
        ) : (
          <Box component="span" sx={{ color: 'admin.inkMuted' }}>
            Deleted user
          </Box>
        ),
    },
    {
      id: 'uploaded',
      label: 'Uploaded',
      width: '8rem',
      sortValue: f => new Date(f.createdAt).getTime(),
      render: f => <RelativeTime at={f.createdAt} />,
    },
    {
      id: 'status',
      label: 'Status',
      width: '8rem',
      render: f =>
        f.status === 'pending' ? (
          <StatusChip tone="info" label="Pending" data-testid={`admin-files-status-${f.id}`} />
        ) : (
          <StatusChip tone="good" label="Complete" data-testid={`admin-files-status-${f.id}`} />
        ),
    },
  ];

  return (
    <Stack sx={{ gap: ADMIN_REGION_GAP, minWidth: 0 }} data-testid="admin-files">
      <AdminPageHeader
        title="Files"
        count={appFiles.data ? files.length : undefined}
        description="Site files such as reports, logos and export templates. Drop up to three files at once to upload."
        actions={<ContextHelpButton helpId="admin/file-management" tooltipText="File Management Help" />}
      />

      <Box
        data-testid="admin-files-dropzone"
        // FilePond draws its panel in three scaled parts, so the frame sits on this wrapper instead.
        sx={{
          border: '1px dashed',
          borderColor: 'admin.borderStrong',
          borderRadius: '8px',
          overflow: 'hidden',
          bgcolor: 'admin.surfaceSubtle',
          '& .filepond--root': { mb: 0, fontFamily: 'inherit' },
          '& .filepond--panel-root': { bgcolor: 'transparent', borderRadius: 0 },
          '& .filepond--drop-label': { color: 'admin.inkSecondary', fontSize: 14 },
          '& .filepond--label-action': { color: 'admin.link', textDecorationColor: 'currentColor' },
        }}
      >
        <FilePondComponent
          allowMultiple={true}
          credits={false}
          maxFiles={3}
          labelTapToCancel=""
          labelTapToUndo=""
          server={{
            process: (
              _fieldName: string,
              file: File,
              _metadata: unknown,
              load: (fileId: string | number) => void,
              error: (message: string) => void
            ) => {
              const abortController = new AbortController();

              const data = {
                type: KnowledgeType.FILE,
                fileName: file.name,
                mimeType: file.type,
                fileSize: file.size,
              };
              createAppFileOnServerWithUpload(data, file, abortController.signal)
                .then(async fabFileId => {
                  if (abortController.signal.aborted) {
                    throw new DOMException('Upload cancelled', 'AbortError');
                  }

                  appFiles.refetch();
                  load(fabFileId);
                })
                .catch(err => {
                  // A user-initiated cancel is not an error.
                  if (err instanceof DOMException && err.name === 'AbortError') return;

                  console.error('error', err);

                  let errorMessage: string = 'Error uploading file';
                  if (axios.isAxiosError(err)) {
                    errorMessage = err.response?.data?.message;
                  } else if (err instanceof Error) {
                    errorMessage = err.message;
                  }

                  error(errorMessage);
                  toast.error(errorMessage);
                });

              // FilePond calls this when the admin cancels an in-flight upload.
              return { abort: () => abortController.abort() };
            },
          }}
          name="files"
          labelIdle='Drag and drop files or <span class="filepond--label-action">Browse</span>'
        />
      </Box>

      <Box sx={{ position: 'relative' }}>
        <UpdatingBar
          active={appFiles.isFetching && !appFiles.isPending}
          placement="overlay"
          testId="admin-files-updating"
        />
        <DataTable
          label="Files"
          testId="admin-files-table"
          rows={files}
          columns={columns}
          getRowId={f => f.id}
          rowTestId={f => `admin-files-row-${f.id}`}
          loading={appFiles.isPending}
          error={appFiles.isError && !appFiles.data ? 'Files could not be loaded.' : undefined}
          onRetry={() => void appFiles.refetch()}
          onRowActivate={editTags}
          rowActions={f => (
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'plain',
                    'aria-label': `Actions for ${f.name}`,
                    sx: { color: 'admin.inkMuted' },
                  },
                }}
                data-testid={`admin-files-row-actions-${f.id}`}
              >
                <MoreHorizIcon sx={{ fontSize: 18 }} />
              </MenuButton>
              <Menu size="sm" placement="bottom-end" sx={{ zIndex: 1300 }}>
                <MenuItem onClick={() => editTags(f)} data-testid={`admin-files-edit-${f.id}`}>
                  Edit tags and description
                </MenuItem>
                {canDelete(f) && (
                  <>
                    <ListDivider />
                    <MenuItem color="danger" onClick={() => setDeleting(f)} data-testid={`admin-files-delete-${f.id}`}>
                      Delete file
                    </MenuItem>
                  </>
                )}
              </Menu>
            </Dropdown>
          )}
          minWidth="64rem"
          maxHeight="none"
          empty={
            <EmptyState
              title="No files yet"
              description="Files you upload above appear here."
              action={
                <Button
                  variant="outlined"
                  onClick={() => void appFiles.refetch()}
                  data-testid="admin-files-refresh-btn"
                >
                  Refresh
                </Button>
              }
            />
          }
        />
      </Box>

      <EditTagModal />
      <ActionDialog
        open={deleting !== null}
        onClose={() => {
          if (!deleteAppFile.isPending) setDeleting(null);
        }}
        title="Delete file"
        description={
          deleting && (
            <>
              <strong>{deleting.name}</strong> is removed from storage and stops being served. This cannot be undone.
            </>
          )
        }
        reasonPresets={ADMIN_REASON_PRESETS.appFileDelete}
        // DELETE /api/app-files/delete logs the deletion but takes no reason.
        reasonAudited={false}
        confirmLabel="Delete file"
        tone="danger"
        pending={deleteAppFile.isPending}
        onConfirm={confirmDelete}
        data-testid="admin-files-delete-dialog"
      />
    </Stack>
  );
};

export default AdminFilesTab;
