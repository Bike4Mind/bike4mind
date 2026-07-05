import React, { useState, useMemo } from 'react';
import {
  Box,
  Typography,
  Card,
  Chip,
  CircularProgress,
  Button,
  IconButton,
  Input,
  Stack,
  Tooltip,
  Modal,
  ModalDialog,
  ModalClose,
  DialogTitle,
  DialogContent,
  List,
  ListItem,
  FormControl,
  FormLabel,
  Divider,
  Alert,
} from '@mui/joy';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useAdminSettings } from '@client/app/contexts/AdminSettingsContext';
import { useUpdateSettings } from '@client/app/hooks/data/settings';
import { toast } from 'sonner';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import PublicIcon from '@mui/icons-material/Public';
import SearchIcon from '@mui/icons-material/Search';
import InfoIcon from '@mui/icons-material/Info';
import DescriptionIcon from '@mui/icons-material/Description';
import { useKnowledgeModal } from '../Knowledge/KnowledgeModal';
import { useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import debounce from 'lodash/debounce';
import WarningIcon from '@mui/icons-material/Warning';

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

export const SystemPromptsManager: React.FC = () => {
  const { getSetting } = useAdminSettings();
  const updateSettingsMutation = useUpdateSettings();
  const queryClient = useQueryClient();
  const { setOpen: setKnowledgeModalOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();

  const [showFilePicker, setShowFilePicker] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);

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
          } catch (error: any) {
            if (error?.response?.status === 404) {
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

  const handleSearch = useMemo(() => {
    const debounced = debounce((value: string) => {
      setSearch(value);
    }, 300);

    // Cleanup on unmount
    return () => {
      debounced.cancel();
    };
  }, []);

  const handleRemoveFile = async (fileId: string) => {
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
    } catch (error) {
      // Revert the optimistic update on error
      queryClient.setQueryData(['system-files', systemFileIds], previousData);
      toast.error('Failed to remove system file');
      console.error(error);
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
      setSelectedFiles([]);
      setShowFilePicker(false);
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

  const configuredCount = systemFileIds.length;
  const missingCount = systemFilesWithStatus.filter((f: SystemFileWithStatus) => f.status === 'missing').length;

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <Card variant="outlined" sx={{ p: 3 }}>
      <Stack spacing={3}>
        {/* Header */}
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={2}>
          <Stack direction="row" alignItems="center" spacing={2} sx={{ flex: 1 }}>
            <PublicIcon sx={{ fontSize: 28 }} />
            <Typography level="h3">Global System Prompts</Typography>
          </Stack>
          <Button
            variant="soft"
            color="primary"
            size="sm"
            startDecorator={<AddIcon />}
            onClick={() => setShowFilePicker(true)}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Add System File
          </Button>
        </Stack>

        <Alert variant="soft" color="neutral" sx={{ mb: 3 }} startDecorator={<InfoIcon />}>
          <Typography level="body-sm">
            Global system prompts are automatically included in all AI conversations for all users. Use them for
            universal instructions, grammar rules, or company-wide guidelines.
          </Typography>
        </Alert>

        <Typography level="title-md" sx={{ mb: 2 }}>
          System Files Configuration ({configuredCount} total)
        </Typography>

        {filesLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
            <CircularProgress />
          </Box>
        ) : filesError ? (
          <Alert color="danger" sx={{ mb: 2 }}>
            <WarningIcon />
            Failed to load system files: {(filesError as any).message || 'Unknown error'}
          </Alert>
        ) : (
          <>
            {missingCount > 0 && (
              <Alert color="warning" sx={{ mb: 2 }} startDecorator={<WarningIcon />}>
                <Typography level="body-sm">
                  {missingCount} system file{missingCount > 1 ? 's' : ''} could not be found (404). You can remove them
                  below.
                </Typography>
              </Alert>
            )}

            {systemFilesWithStatus.length === 0 ? (
              <Card variant="outlined" sx={{ p: 3, textAlign: 'center', backgroundColor: 'background.level1' }}>
                <Typography level="body-lg" sx={{ color: 'text.secondary' }}>
                  No global system files configured. Add files to provide universal AI instructions.
                </Typography>
              </Card>
            ) : (
              <Stack spacing={2}>
                {/* Show loaded files first */}
                {systemFilesWithStatus
                  .filter(
                    (item): item is SystemFileWithStatus & { status: 'loaded'; file: SystemFile } =>
                      item.status === 'loaded' && item.file !== undefined
                  )
                  .map((item: SystemFileWithStatus & { status: 'loaded'; file: SystemFile }, index: number) => {
                    const file = item.file;
                    return (
                      <Card key={item.id} variant="outlined" sx={{ p: 2 }}>
                        <Stack direction="row" alignItems="center" spacing={2}>
                          <Chip size="sm" variant="soft" color="primary">
                            #{index + 1}
                          </Chip>
                          <DescriptionIcon sx={{ color: 'text.secondary' }} />
                          <Box sx={{ flex: 1 }}>
                            <Typography level="title-sm">{file.fileName}</Typography>
                            <Stack direction="row" spacing={2}>
                              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                                ID: {item.id}
                              </Typography>
                              <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                                {file.fileType || file.mimeType} • {formatFileSize(file.fileSize || 0)}
                              </Typography>
                              {file.updatedAt && (
                                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                                  Updated: {new Date(file.updatedAt).toLocaleDateString()}
                                </Typography>
                              )}
                            </Stack>
                          </Box>
                          <IconButton size="sm" variant="plain" color="neutral" onClick={() => handleViewFile(item.id)}>
                            <VisibilityIcon />
                          </IconButton>
                          <IconButton
                            size="sm"
                            variant="plain"
                            color="danger"
                            onClick={() => handleRemoveFile(item.id)}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Stack>
                      </Card>
                    );
                  })}

                {/* Show missing files */}
                {systemFilesWithStatus
                  .filter((item: SystemFileWithStatus) => item.status === 'missing')
                  .map((item: SystemFileWithStatus) => (
                    <Card key={item.id} variant="outlined" sx={{ p: 2, backgroundColor: 'danger.softBg' }}>
                      <Stack direction="row" alignItems="center" spacing={2}>
                        <Chip size="sm" variant="soft" color="danger">
                          Missing
                        </Chip>
                        <WarningIcon sx={{ color: 'danger.plainColor' }} />
                        <Box sx={{ flex: 1 }}>
                          <Typography level="title-sm" sx={{ color: 'danger.plainColor' }}>
                            File Not Found
                          </Typography>
                          <Typography level="body-xs" sx={{ color: 'danger.plainColor' }}>
                            ID: {item.id}
                          </Typography>
                        </Box>
                        <Tooltip title="Remove this missing file reference">
                          <IconButton
                            size="sm"
                            variant="solid"
                            color="danger"
                            onClick={() => handleRemoveFile(item.id)}
                          >
                            <DeleteIcon />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </Card>
                  ))}
              </Stack>
            )}
          </>
        )}

        {/* File Picker Modal */}
        <Modal open={showFilePicker} onClose={() => setShowFilePicker(false)}>
          <ModalDialog size="lg" sx={{ maxWidth: '600px' }}>
            <DialogTitle>
              <Typography level="h4">Add System Files</Typography>
              <ModalClose />
            </DialogTitle>
            <DialogContent>
              <Stack spacing={2}>
                <FormControl>
                  <FormLabel>Search Files</FormLabel>
                  <Input
                    placeholder="Search by file name..."
                    startDecorator={<SearchIcon />}
                    onChange={e => handleSearch()}
                  />
                </FormControl>

                <Box sx={{ maxHeight: '400px', overflowY: 'auto' }}>
                  {searchLoading ? (
                    <Box sx={{ textAlign: 'center', p: 3 }}>
                      <CircularProgress size="sm" />
                    </Box>
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
                                width: '100%',
                                opacity: isAlreadySystem ? 0.5 : 1,
                              }}
                            >
                              <Box>
                                <Typography>{file.fileName}</Typography>
                                <Typography level="body-xs" sx={{ color: 'text.secondary' }}>
                                  {file.mimeType} • {formatFileSize(file.fileSize)}
                                </Typography>
                              </Box>
                              {isAlreadySystem ? (
                                <Chip size="sm" color="success" variant="soft">
                                  Already Added
                                </Chip>
                              ) : (
                                <Button
                                  size="sm"
                                  variant={isSelected ? 'solid' : 'outlined'}
                                  color={isSelected ? 'success' : 'neutral'}
                                  onClick={() => {
                                    if (isSelected) {
                                      setSelectedFiles(prev => prev.filter((id: string) => id !== file.id));
                                    } else {
                                      setSelectedFiles(prev => [...prev, file.id]);
                                    }
                                  }}
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

                <Divider />

                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography level="body-sm">{selectedFiles.length} file(s) selected</Typography>
                  <Stack direction="row" spacing={1}>
                    <Button
                      variant="plain"
                      color="neutral"
                      onClick={() => {
                        setShowFilePicker(false);
                        setSelectedFiles([]);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button startDecorator={<AddIcon />} disabled={selectedFiles.length === 0} onClick={handleAddFiles}>
                      Add Selected Files
                    </Button>
                  </Stack>
                </Box>
              </Stack>
            </DialogContent>
          </ModalDialog>
        </Modal>
      </Stack>
    </Card>
  );
};
