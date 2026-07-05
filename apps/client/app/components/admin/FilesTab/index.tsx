import EditTagModal, { useEditAppFileTagModal } from '@client/app/components/admin/FilesTab/EditTagModal';
import { IAppFile, IAppFileDocument, KnowledgeType } from '@bike4mind/common';
import { Edit } from '@mui/icons-material';
import { Box, Button, Chip, CircularProgress, IconButton, LinearProgress, Table } from '@mui/joy';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import dayjs from 'dayjs';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import FilePondPluginImageExifOrientation from 'filepond-plugin-image-exif-orientation';
import FilePondPluginImagePreview from 'filepond-plugin-image-preview';
import 'filepond-plugin-image-preview/dist/filepond-plugin-image-preview.css';
import 'filepond/dist/filepond.min.css';
import { FilePond, registerPlugin } from 'react-filepond';

// Type assertion for FilePond component
const FilePondComponent = FilePond as any;
import { toast } from 'sonner';
import prettyBytes from 'pretty-bytes';
import { useCallback, useMemo, useState } from 'react';
import ConfirmActionModal from '@client/app/components/ConfirmActionModal';
import { createAppFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { useGetReports } from '@client/app/hooks/data/appFile';
import { api } from '@client/app/contexts/ApiContext';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

dayjs.extend(localizedFormat);

registerPlugin(FilePondPluginImageExifOrientation, FilePondPluginImagePreview);

const AdminFilesTab = () => {
  const appFiles = useGetReports();
  const setTargetEditTagFile = useEditAppFileTagModal(state => state.setTargetFile);
  useSubscribeCollection<IAppFile>(
    'appfiles',
    useMemo(() => ({}), []),
    useCallback(
      (type: string) => {
        switch (type) {
          case 'update':
            appFiles.refetch();
            break;
          default:
            break;
        }
      },
      [appFiles]
    )
  );

  const [deleteFileId, setDeleteFileId] = useState<string | null>(null);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const queryClient = useQueryClient();
  const deleteAppFile = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/app-files/delete`, {
        data: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-files'] });
      toast.success('File deleted');
      closeDeleteModal();
    },
  });

  const confirmDeleteFile = () => {
    if (deleteFileId) {
      deleteAppFile.mutate(deleteFileId);
    }
  };

  const openDeleteModal = (fileId: string) => {
    setDeleteFileId(fileId);
    setIsDeleteModalOpen(true);
  };

  const closeDeleteModal = () => {
    setDeleteFileId(null);
    setIsDeleteModalOpen(false);
  };

  return (
    <div>
      <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
        <ContextHelpButton helpId="admin/file-management" tooltipText="File Management Help" />
      </Box>
      <FilePondComponent
        allowMultiple={true}
        credits={false}
        maxFiles={3}
        labelTapToCancel=""
        labelTapToUndo=""
        server={{
          process: (
            fieldName: string,
            file: File,
            metadata: any,
            load: (fileId: string | number) => void,
            error: (message: string) => void,
            progress: (computable: boolean, loaded: number, total: number) => void,
            abort: () => void
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
                // Check one final time before completing
                if (abortController.signal.aborted) {
                  throw new DOMException('Upload cancelled', 'AbortError');
                }

                appFiles.refetch();
                load(fabFileId);
              })
              .catch(err => {
                // Don't show error for user-initiated cancellations
                if (err instanceof DOMException && err.name === 'AbortError') {
                  console.log('Upload cancelled by user');
                  return; // Silent cancellation
                }

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

            // CRITICAL: Return abort function to FilePond
            return {
              abort: () => {
                console.log('Aborting upload for file:', file.name);
                abortController.abort();
              },
            };
          },
        }}
        name="files" /* sets the file input name, it's filepond by default */
        labelIdle='Drag & Drop your files or <span class="filepond--label-action">Browse</span>'
      />

      <div>
        {appFiles.isFetching && <LinearProgress />}
        Number of Files = {appFiles.data?.length}
        <Table hoverRow stripe="odd">
          <thead>
            <tr>
              <th>File Name</th>
              <th>File Path</th>
              <th>File Size</th>
              <th>Tags</th>
              <th>Uploaded By</th>
              <th>Uploaded At</th>
              <th>Upload Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {appFiles.data?.map(file => (
              <tr key={file.id}>
                <td>{file.name}</td>
                <td>{file.path}</td>
                <td>{prettyBytes(file.size)}</td>
                <td>
                  <Box sx={{ display: 'flex', gap: '.25rem', flexWrap: 'wrap' }}>
                    {file.tags?.map(tag => (
                      <Chip key={tag}>{tag}</Chip>
                    ))}

                    <IconButton
                      size="sm"
                      variant="solid"
                      onClick={() => setTargetEditTagFile(file as unknown as IAppFileDocument)}
                    >
                      <Edit />
                    </IconButton>
                  </Box>
                </td>
                <td>
                  {file.userId.name} ({file.userId.email})
                </td>
                <td>{dayjs(file.createdAt).format('LL')}</td>
                <td>
                  <Box
                    sx={{
                      display: 'flex',
                      gap: '.25rem',
                      alignItems: 'center',
                    }}
                  >
                    {file.status === 'pending' && <CircularProgress size="sm" />}
                    <span>{file.status}</span>
                  </Box>
                </td>
                <td>
                  <DeleteFileButton id={file.id} onDelete={openDeleteModal} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>

      <EditTagModal />
      <ConfirmActionModal
        loading={deleteAppFile.isPending}
        open={isDeleteModalOpen}
        onGoBackward={closeDeleteModal}
        onGoForward={confirmDeleteFile}
        title="Delete File"
        description="Are you sure you want to delete this file? This action cannot be undone."
      />
    </div>
  );
};

const DeleteFileButton = ({ id, onDelete }: { id: string; onDelete: (id: string) => void }) => {
  const queryClient = useQueryClient();
  const deleteAppFile = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/api/app-files/delete`, {
        data: { id },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['app-files'] });
      toast.success('File deleted');
    },
  });

  return (
    <Button color="danger" loading={deleteAppFile.isPending} onClick={() => onDelete(id)}>
      Delete
    </Button>
  );
};

export default AdminFilesTab;
