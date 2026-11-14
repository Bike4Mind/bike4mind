import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
  DialogContent,
  FormControl,
  FormLabel,
  Input,
  List,
  ListDivider,
  ListItem,
  MenuItem,
  Stack,
  Typography,
} from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { toast } from 'sonner';
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import { useKnowledgeModal } from '../Knowledge/KnowledgeModal';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import debounce from 'lodash/debounce';
import {
  ActionDialog,
  ADMIN_REASON_PRESETS,
  AdminDialog,
  DataTable,
  EmptyState,
  LoadingState,
  StatusChip,
  type DataColumn,
} from './shared';
import { adminFocus } from './shared/adminStyles';
import { Dash, TruncatedText } from './promptAndToolParts';
import { RowActionsMenu } from './shared/RowActionsMenu';

interface SystemFile {
  id: string;
  fileName: string;
  fileType?: string;
  mimeType?: string;
  fileSize: number;
  system?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface SystemFileWithStatus {
  id: string;
  file?: SystemFile;
  status: 'loaded' | 'missing';
}

function FileRowMenu({
  item,
  onView,
  onRemove,
}: {
  item: SystemFileWithStatus;
  onView: (fileId: string) => void;
  onRemove: (item: SystemFileWithStatus) => void;
}) {
  return (
    <RowActionsMenu
      testId={`system-files-row-actions-${item.id}`}
      ariaLabel={`Actions for ${item.file?.fileName ?? item.id}`}
    >
      {item.status === 'loaded' && (
        <>
          <MenuItem onClick={() => onView(item.id)} data-testid={`system-files-row-view-${item.id}`}>
            View file
          </MenuItem>
          <ListDivider />
        </>
      )}
      <MenuItem onClick={() => onRemove(item)} data-testid={`system-files-row-remove-${item.id}`}>
        Remove from list
      </MenuItem>
    </RowActionsMenu>
  );
}

export const SystemPromptsManager: React.FC = () => {
  const { getSetting } = useAdminSettings();
  const updateSettingsMutation = useUpdateSettings();
  const queryClient = useQueryClient();
  const { setOpen: setKnowledgeModalOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();

  const [showFilePicker, setShowFilePicker] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [removingFile, setRemovingFile] = useState<SystemFileWithStatus | null>(null);

  const systemFileIds = useMemo(() => {
    const settingValue = getSetting('SystemFiles', '');
    return String(settingValue)
      .split(',')
      .map((id: string) => id.trim())
      .filter(Boolean);
  }, [getSetting]);

  const {
    data: systemFilesWithStatus = [],
    isLoading: filesLoading,
    error: filesError,
    refetch: refetchFiles,
  } = useQuery({
    queryKey: ['system-files', systemFileIds],
    queryFn: async () => {
      if (systemFileIds.length === 0) return [];

      try {
        // Fetch files individually to handle 404s gracefully
        const filePromises = systemFileIds.map(async (id: string): Promise<SystemFileWithStatus> => {
          try {
            const response = await api.get<SystemFile>(`/api/files/${id}`);
            return {
              id,
              file: response.data,
              status: 'loaded',
            };
          } catch (error: unknown) {
            if ((error as { response?: { status?: number } } | null)?.response?.status === 404) {
              console.warn(`❌ System prompt file ${id} not found (404)`);
              return {
                id,
                status: 'missing',
              };
            }
            throw error;
          }
        });

        const results = await Promise.all(filePromises);
        return results;
      } catch (err) {
        console.error('Failed to fetch system files:', err);
        // Return all IDs as missing if there's an error
        return systemFileIds.map((id: string) => ({ id, status: 'missing' as const }));
      }
    },
    enabled: systemFileIds.length > 0,
  });

  const { data: availableFilesData, isFetching: searchLoading } = useGetFabFiles(search);
  const availableFiles = useMemo(
    () => availableFilesData?.pages?.flatMap(page => page.data) || [],
    [availableFilesData]
  );

  // Searches once typing pauses for 300 ms.
  const handleSearch = useMemo(() => debounce((value: string) => setSearch(value), 300), []);
  useEffect(() => () => handleSearch.cancel(), [handleSearch]);

  const closePicker = useCallback(() => {
    handleSearch.cancel();
    setSearch('');
    setSelectedFiles([]);
    setShowFilePicker(false);
  }, [handleSearch]);

  /** Resolves true once the settings write succeeds; a failure is reported by toast and rolled back. */
  const handleRemoveFile = async (fileId: string): Promise<boolean> => {
    // Store the current data for potential rollback
    const previousData = queryClient.getQueryData(['system-files', systemFileIds]);

    try {
      const newFileIds = systemFileIds.filter((id: string) => id !== fileId);

      queryClient.cancelQueries({ queryKey: ['system-files'] });

      queryClient.setQueriesData({ queryKey: ['system-files'] }, (oldData: SystemFileWithStatus[] | undefined) => {
        if (!oldData) return [];
        return oldData.filter(item => item.id !== fileId);
      });

      await updateSettingsMutation.mutateAsync(
        {
          key: 'SystemFiles',
          value: newFileIds.join(','),
        },
        {
          onSettled: () => {
            queryClient.invalidateQueries({
              queryKey: ['system-files'],
              refetchType: 'active',
            });
          },
        }
      );

      toast.success('System file removed successfully');
      return true;
    } catch (error) {
      // Revert the optimistic update on error
      queryClient.setQueryData(['system-files', systemFileIds], previousData);
      toast.error('Failed to remove system file');
      console.error(error);
      return false;
    }
  };

  const handleAddFiles = async () => {
    try {
      const newFileIds = [...systemFileIds, ...selectedFiles.filter((id: string) => !systemFileIds.includes(id))];

      // Optimistically update the query data
      queryClient.cancelQueries({ queryKey: ['system-files'] });
      queryClient.setQueriesData({ queryKey: ['system-files'] }, (oldData: SystemFileWithStatus[] | undefined) => {
        if (!oldData) return [];
        return [...oldData, ...selectedFiles.map(id => ({ id, status: 'loaded' as const }))];
      });

      await updateSettingsMutation.mutateAsync(
        {
          key: 'SystemFiles',
          value: newFileIds.join(','),
        },
        {
          onSettled: () => {
            queryClient.invalidateQueries({
              queryKey: ['system-files'],
              refetchType: 'active',
            });
          },
        }
      );

      toast.success(`Added ${selectedFiles.length} system file(s)`);
      closePicker();
    } catch (error) {
      toast.error('Failed to add system files');
      console.error(error);
    }
  };

  const handleViewFile = (fileId: string) => {
    setSelectedFabFileId(fileId);
    setViewOnly(true);
    setKnowledgeModalOpen(true);
  };

  const missingCount = systemFilesWithStatus.filter((f: SystemFileWithStatus) => f.status === 'missing').length;

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  // Files still loading after an optimistic add have no `file` yet and wait for the refetch.
  const listedFiles = [
    ...systemFilesWithStatus.filter(item => item.status === 'loaded' && item.file !== undefined),
    ...systemFilesWithStatus.filter(item => item.status === 'missing'),
  ];

  const fileColumns: DataColumn<SystemFileWithStatus>[] = [
    {
      id: 'name',
      label: 'File',
      render: item =>
        item.file ? (
          <TruncatedText text={item.file.fileName} testId={`system-files-name-${item.id}`} />
        ) : (
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            File not found
          </Typography>
        ),
    },
    {
      id: 'id',
      label: 'ID',
      width: '14rem',
      render: item => <TruncatedText text={item.id} mono />,
    },
    {
      id: 'type',
      label: 'Type',
      width: '10rem',
      render: item => {
        const type = item.file?.fileType || item.file?.mimeType;
        return type ? <TruncatedText text={type} /> : <Dash />;
      },
    },
    {
      id: 'size',
      label: 'Size',
      width: '6rem',
      numeric: true,
      render: item => (item.file ? formatFileSize(item.file.fileSize || 0) : <Dash />),
    },
    {
      id: 'updated',
      label: 'Updated',
      width: '7.5rem',
      render: item => (item.file?.updatedAt ? new Date(item.file.updatedAt).toLocaleDateString() : <Dash />),
    },
    {
      id: 'status',
      label: 'Status',
      width: '6.5rem',
      render: item =>
        item.status === 'missing' ? (
          <StatusChip tone="bad" label="Missing" data-testid={`system-files-status-${item.id}`} />
        ) : (
          <StatusChip tone="good" label="Available" data-testid={`system-files-status-${item.id}`} />
        ),
    },
  ];

  return (
    <Stack component="section" gap={1.5} sx={{ minWidth: 0 }} data-testid="system-files-section">
      <Stack direction="row" flexWrap="wrap" alignItems="flex-start" justifyContent="space-between" gap={1}>
        <Box sx={{ minWidth: 0 }}>
          <Typography level="title-md" component="h2" sx={{ color: 'admin.ink' }} data-testid="system-files-title">
            Global knowledge files
          </Typography>
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }}>
            Included in every AI conversation for every user: universal instructions, grammar rules or company-wide
            guidelines.
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="sm"
          startDecorator={<AddIcon sx={{ fontSize: 16 }} />}
          onClick={() => setShowFilePicker(true)}
          data-testid="system-files-add-btn"
          sx={adminFocus}
        >
          Add files
        </Button>
      </Stack>

      {missingCount > 0 && (
        <Alert color="warning" variant="soft" data-testid="system-files-missing-banner">
          {missingCount} system file{missingCount > 1 ? 's' : ''} could not be found (404). Remove{' '}
          {missingCount > 1 ? 'them' : 'it'} from the list with the row menu.
        </Alert>
      )}

      <DataTable
        label="Global knowledge files"
        testId="system-files-table"
        rows={listedFiles}
        columns={fileColumns}
        getRowId={item => item.id}
        rowTestId={item => `system-files-row-${item.id}`}
        loading={filesLoading}
        error={filesError ? 'Could not load the knowledge files.' : undefined}
        onRetry={() => void refetchFiles()}
        empty={
          <EmptyState
            title="No knowledge files yet"
            description="Add files to provide universal AI instructions."
            action={
              <Button
                variant="outlined"
                onClick={() => setShowFilePicker(true)}
                data-testid="system-files-empty-add-btn"
              >
                Add files
              </Button>
            }
          />
        }
        rowActions={item => <FileRowMenu item={item} onView={handleViewFile} onRemove={setRemovingFile} />}
        pagination={false}
        // Wide enough that every column keeps one line; below it the table scrolls inside its frame.
        minWidth="60rem"
        maxHeight="none"
      />

      <ActionDialog
        open={removingFile !== null}
        // The settings write is already in flight; closing now would hide its outcome.
        onClose={() => {
          if (!updateSettingsMutation.isPending) setRemovingFile(null);
        }}
        title="Remove knowledge file"
        description={
          <>
            Removes <strong>{removingFile?.file?.fileName ?? removingFile?.id}</strong> from the global knowledge files,
            so it is no longer included in AI conversations for any user. The file itself is not deleted.
          </>
        }
        reasonPresets={ADMIN_REASON_PRESETS.knowledgeFileRemoval}
        // PUT /api/settings/update records the change in the audit log but takes no reason.
        reasonAudited={false}
        confirmLabel="Remove file"
        tone="danger"
        pending={updateSettingsMutation.isPending}
        onConfirm={async () => {
          if (removingFile && (await handleRemoveFile(removingFile.id))) setRemovingFile(null);
        }}
        data-testid="system-files-remove-dialog"
      />

      <AdminDialog
        open={showFilePicker}
        onClose={closePicker}
        title="Add system files"
        width={600}
        data-testid="system-files-add-dialog"
      >
        <DialogContent sx={{ gap: 2 }}>
          <FormControl>
            <FormLabel>Search files</FormLabel>
            <Input
              placeholder="Search by file name..."
              startDecorator={<SearchIcon />}
              onChange={e => handleSearch(e.target.value)}
              slotProps={{ input: { 'data-testid': 'system-files-search-input' } }}
            />
          </FormControl>

          {/* The padding keeps the focus rings of the pick buttons inside this scroll box. */}
          <Box sx={{ maxHeight: '400px', overflowY: 'auto', p: 0.5 }}>
            {searchLoading ? (
              <LoadingState label="Loading files" />
            ) : (
              <List>
                {availableFiles.map(file => {
                  const isAlreadySystem = systemFileIds.includes(file.id);
                  const isSelected = selectedFiles.includes(file.id);

                  return (
                    <ListItem key={file.id}>
                      <Box
                        sx={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 1,
                          width: '100%',
                        }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography level="body-sm" noWrap sx={{ color: 'admin.ink' }}>
                            {file.fileName}
                          </Typography>
                          <Typography level="body-xs" sx={{ color: 'admin.inkMuted' }}>
                            {file.mimeType} {'\u2022'} {formatFileSize(file.fileSize)}
                          </Typography>
                        </Box>
                        {isAlreadySystem ? (
                          <StatusChip
                            tone="neutral"
                            label="Already added"
                            data-testid={`system-files-already-added-${file.id}`}
                          />
                        ) : (
                          <Button
                            size="sm"
                            variant={isSelected ? 'soft' : 'outlined'}
                            color="neutral"
                            aria-pressed={isSelected}
                            onClick={() => {
                              if (isSelected) {
                                setSelectedFiles(prev => prev.filter((id: string) => id !== file.id));
                              } else {
                                setSelectedFiles(prev => [...prev, file.id]);
                              }
                            }}
                            data-testid={`system-files-pick-${file.id}`}
                          >
                            {isSelected ? 'Selected' : 'Select'}
                          </Button>
                        )}
                      </Box>
                    </ListItem>
                  );
                })}
              </List>
            )}
          </Box>
        </DialogContent>

        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          flexWrap="wrap"
          gap={1}
          sx={{ pt: 2, mt: 1, borderTop: '1px solid', borderColor: 'admin.border' }}
        >
          <Typography level="body-sm" sx={{ color: 'admin.inkMuted' }} data-testid="system-files-selected-count">
            {selectedFiles.length} file(s) selected
          </Typography>
          <Stack direction="row" gap={1}>
            <Button variant="plain" color="neutral" onClick={closePicker} data-testid="system-files-add-cancel-btn">
              Cancel
            </Button>
            <Button
              startDecorator={<AddIcon />}
              disabled={selectedFiles.length === 0}
              onClick={handleAddFiles}
              data-testid="system-files-add-confirm-btn"
            >
              Add selected files
            </Button>
          </Stack>
        </Stack>
      </AdminDialog>
    </Stack>
  );
};
