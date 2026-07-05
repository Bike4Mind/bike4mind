import { IUser, ISystemFileEntry, SettingKey, IFabFileDocument, KnowledgeType } from '@bike4mind/common';
import {
  List,
  ListItem,
  Typography,
  Button,
  Box,
  Input,
  CircularProgress,
  Select,
  Option,
  Dropdown,
  IconButton,
  Menu,
  MenuButton,
  MenuItem,
  Tooltip,
  Modal,
  ModalDialog,
  ModalClose,
  Chip,
} from '@mui/joy';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { updateUserToServer } from '@client/app/utils/userAPICalls';
import { toast } from 'sonner';
import { useEffect, useState, useMemo, useCallback, memo, useRef } from 'react';
import { createFabFileOnServerWithUpload } from '@client/app/utils/filesAPICalls';
import { getErrorMessage } from '@client/app/utils/error';
import { useGetFabFile, useGetFabFiles } from '@client/app/hooks/data/fabFiles';
import { Sort, Search, Add, AutoFixHigh } from '@mui/icons-material';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import PublicIcon from '@mui/icons-material/Public';
import { useKnowledgeModal } from '../Knowledge/KnowledgeModal';
import { useSettingsFromServer, useUpdateSettings } from '@client/app/hooks/data/settings';
import debounce from 'lodash/debounce';
import { useUser } from '@client/app/contexts/UserContext';
import { GetFileIcon } from '@client/app/utils/fabFileUtils';
import { grayAlpha } from '@client/app/utils/themes/colors';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import SectionContainer from './SectionContainer';
import { cardSurfaceSx } from './settingsStyles';

interface SystemPromptsTabProps {
  user: IUser;
}

interface SystemFile extends ISystemFileEntry {
  systemPriority?: number;
}

const SORT_OPTIONS = {
  NEWEST: 'newest',
  OLDEST: 'oldest',
  NAME: 'name',
} as const;

type SortOption = (typeof SORT_OPTIONS)[keyof typeof SORT_OPTIONS];

const SORT_CONFIG = [
  { value: SORT_OPTIONS.NEWEST, label: 'Newest First' },
  { value: SORT_OPTIONS.OLDEST, label: 'Oldest First' },
  { value: SORT_OPTIONS.NAME, label: 'Name (A-Z)' },
] as const;

const useSortedAvailableFiles = (fabFiles: IFabFileDocument[] | undefined, sortBy: SortOption, currentUser: IUser) => {
  return useMemo(() => {
    if (!fabFiles) return [];

    const userSystemFileIds = currentUser.systemFiles?.map(sf => sf.fileId) || [];
    const availableFiles = fabFiles.filter(file => !userSystemFileIds.includes(file.id));

    return [...availableFiles].sort((a, b) => {
      switch (sortBy) {
        case SORT_OPTIONS.NEWEST:
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case SORT_OPTIONS.OLDEST:
          return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        case SORT_OPTIONS.NAME:
          return a.fileName.localeCompare(b.fileName);
        default:
          return 0;
      }
    });
  }, [fabFiles, sortBy, currentUser.systemFiles]);
};

export function SystemPromptsTab({ user }: SystemPromptsTabProps) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortOption>(SORT_OPTIONS.NEWEST);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Global loading state to prevent race conditions
  const [isAnyOperationLoading, setIsAnyOperationLoading] = useState(false);
  const [loadingStates, setLoadingStates] = useState<{
    add: Set<string>;
    toggle: Set<string>;
    delete: Set<string>;
  }>({
    add: new Set(),
    toggle: new Set(),
    delete: new Set(),
  });

  // File Browser Modal state
  const [isFileBrowserModalOpen, setIsFileBrowserModalOpen] = useState(false);

  const { data, isFetching } = useGetFabFiles(search);

  const fabFiles = useMemo(() => data?.pages?.map(page => page.data).flat(), [data]);

  const handleSearch = useMemo(
    () =>
      debounce((value: string) => {
        setSearch(value);
      }, 300),
    []
  );

  // Cleanup debounced function on unmount
  useEffect(() => {
    return () => {
      handleSearch.cancel();
    };
  }, [handleSearch]);

  const { setOpen, setSelectedFabFileId, setViewOnly } = useKnowledgeModal();

  const { data: currentUser } = useQuery({
    queryKey: ['user', user.id],
    initialData: user,
  });

  const sortedFabFiles = useSortedAvailableFiles(fabFiles, sortBy, currentUser);

  const handleSortChange = useCallback((_: React.SyntheticEvent | null, value: SortOption | null) => {
    if (value) {
      setSortBy(value);
    }
  }, []);

  const { data: serverSettings } = useSettingsFromServer();
  const updateSettingsMutation = useUpdateSettings();
  const { isAdmin } = useUser();

  const globalSystemFileIds = useMemo(
    () =>
      serverSettings
        ?.find(s => s.settingName === 'SystemFiles')
        ?.settingValue?.split(',')
        .map(id => id.trim())
        .filter(Boolean) ?? [],
    [serverSettings]
  );

  // Helper functions for loading state management
  const updateLoadingState = useCallback((action: 'add' | 'toggle' | 'delete', fileId: string, isLoading: boolean) => {
    setLoadingStates(prev => {
      const newStates = { ...prev };
      const currentSet = new Set(prev[action]);

      if (isLoading) {
        currentSet.add(fileId);
      } else {
        currentSet.delete(fileId);
      }

      newStates[action] = currentSet;

      // Update global loading state
      const hasAnyLoading = Array.from(Object.values(newStates)).some(set => set.size > 0);
      setIsAnyOperationLoading(hasAnyLoading);

      return newStates;
    });
  }, []);

  const isFileLoading = useCallback(
    (action: 'add' | 'toggle' | 'delete', fileId: string) => {
      return loadingStates[action].has(fileId);
    },
    [loadingStates]
  );

  const addSystemPromptMutation = useMutation<IUser, Error, string, { previousUser?: IUser; fileName?: string }>({
    onMutate: async (fileId: string) => {
      updateLoadingState('add', fileId, true);

      await queryClient.cancelQueries({ queryKey: ['user', user.id] });

      const previousUser = queryClient.getQueryData<IUser>(['user', user.id]);

      const fileName = fabFiles?.find(f => f.id === fileId)?.fileName;

      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;

      const existingFile = latestUser.systemFiles?.find(sf => sf.fileId === fileId);
      if (existingFile) {
        updateLoadingState('add', fileId, false);
        return { previousUser, fileName };
      }

      const maxPriority = Math.max(
        0,
        ...(latestUser.systemFiles || []).map(f => (f as SystemFile).systemPriority || 0)
      );

      const optimisticUser: IUser = {
        ...latestUser,
        systemFiles: [
          ...(latestUser.systemFiles || []),
          {
            fileId,
            enabled: true,
            systemPriority: maxPriority + 1,
          } as SystemFile,
        ],
      };

      queryClient.setQueryData(['user', user.id], optimisticUser);

      return { previousUser, fileName };
    },
    mutationFn: async (fileId: string) => {
      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;
      const updatedSystemFiles =
        latestUser.systemFiles?.map(file => (file.fileId === fileId ? { ...file, enabled: true } : file)) || [];
      return await updateUserToServer(user.id, { systemFiles: updatedSystemFiles });
    },
    onSuccess: (_updatedUser, fileId, context) => {
      updateLoadingState('add', fileId, false);
      const fileName = context?.fileName || 'System prompt';
      toast.success(`"${fileName}" added successfully`);

      // Invalidate system prompt files cache to ensure sessions pick up the new system prompt immediately
      queryClient.invalidateQueries({ queryKey: ['system-prompt-files'] });
    },
    onError: (_error, fileId, context) => {
      updateLoadingState('add', fileId, false);
      // Rollback optimistic update
      if (context?.previousUser) {
        queryClient.setQueryData(['user', user.id], context.previousUser);
      }
      const fileName = context?.fileName || 'System prompt';
      toast.error(`Failed to add "${fileName}"`);
    },
    onSettled: (data, error, fileId) => {
      updateLoadingState('add', fileId, false);
      // Only invalidate on error, success will use the returned data
      if (error) {
        queryClient.invalidateQueries({ queryKey: ['user', user.id], refetchType: 'active' });
      } else if (data) {
        // Set the authoritative server response
        queryClient.setQueryData(['user', user.id], data);
      }
    },
  });

  const toggleMutation = useMutation<
    IUser,
    Error,
    { fileId: string; enabled: boolean },
    { previousUser?: IUser; fileName?: string }
  >({
    onMutate: async ({ fileId, enabled }) => {
      updateLoadingState('toggle', fileId, true);

      await queryClient.cancelQueries({ queryKey: ['user', user.id] });
      const previousUser = queryClient.getQueryData<IUser>(['user', user.id]);

      const fileName = fabFiles?.find(f => f.id === fileId)?.fileName;

      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;
      const optimisticUser: IUser = {
        ...latestUser,
        systemFiles: latestUser.systemFiles?.map(file => (file.fileId === fileId ? { ...file, enabled } : file)) || [],
      };
      queryClient.setQueryData(['user', user.id], optimisticUser);
      return { previousUser, fileName };
    },
    mutationFn: async ({ fileId, enabled }) => {
      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;
      const updatedSystemFiles =
        latestUser.systemFiles?.map(file => (file.fileId === fileId ? { ...file, enabled } : file)) || [];
      return await updateUserToServer(user.id, { systemFiles: updatedSystemFiles });
    },
    onSuccess: (updatedUser, { fileId }, context) => {
      updateLoadingState('toggle', fileId, false);
      const fileName = context?.fileName || 'System prompt';
      const action = updatedUser.systemFiles?.find(f => f.fileId === fileId)?.enabled ? 'enabled' : 'disabled';
      toast.success(`"${fileName}" ${action}`);

      // Invalidate system prompt files cache
      queryClient.invalidateQueries({ queryKey: ['system-prompt-files'] });
    },
    onError: (_error, { fileId }, context) => {
      updateLoadingState('toggle', fileId, false);
      if (context?.previousUser) {
        queryClient.setQueryData(['user', user.id], context.previousUser);
      }
      const fileName = context?.fileName || 'System prompt';
      toast.error(`Failed to toggle "${fileName}"`);
    },
    onSettled: (data, error, { fileId }) => {
      updateLoadingState('toggle', fileId, false);
      if (error) {
        queryClient.invalidateQueries({ queryKey: ['user', user.id], refetchType: 'active' });
      } else if (data) {
        queryClient.setQueryData(['user', user.id], data);
      }
    },
  });

  const deleteSystemPromptMutation = useMutation<IUser, Error, string, { previousUser?: IUser; fileName?: string }>({
    onMutate: async (fileId: string) => {
      updateLoadingState('delete', fileId, true);
      await queryClient.cancelQueries({ queryKey: ['user', user.id] });
      const previousUser = queryClient.getQueryData<IUser>(['user', user.id]);
      const fileName = fabFiles?.find(f => f.id === fileId)?.fileName;
      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;
      const optimisticUser: IUser = {
        ...latestUser,
        systemFiles: latestUser.systemFiles?.filter(f => f.fileId !== fileId) || [],
      };
      queryClient.setQueryData(['user', user.id], optimisticUser);
      return { previousUser, fileName };
    },
    mutationFn: async (fileId: string) => {
      const latestUser = queryClient.getQueryData<IUser>(['user', user.id]) || currentUser;
      const updatedSystemFiles = latestUser.systemFiles?.filter(f => f.fileId !== fileId) || [];
      return await updateUserToServer(user.id, { systemFiles: updatedSystemFiles });
    },
    onSuccess: (_updatedUser, fileId, context) => {
      updateLoadingState('delete', fileId, false);
      const fileName = context?.fileName || 'System prompt';
      toast.success(`"${fileName}" removed successfully`);

      // Invalidate system prompt files cache
      queryClient.invalidateQueries({ queryKey: ['system-prompt-files'] });
    },
    onError: (_error, fileId, context) => {
      updateLoadingState('delete', fileId, false);
      if (context?.previousUser) {
        queryClient.setQueryData(['user', user.id], context.previousUser);
      }
      const fileName = context?.fileName || 'System prompt';
      toast.error(`Failed to remove "${fileName}"`);
    },
    onSettled: (data, error, fileId) => {
      updateLoadingState('delete', fileId, false);
      if (error) {
        queryClient.invalidateQueries({ queryKey: ['user', user.id], refetchType: 'active' });
      } else if (data) {
        queryClient.setQueryData(['user', user.id], data);
      }
    },
  });

  const toggleGlobalSystemFile = useCallback(
    async (fileId: string, shouldBeGlobal: boolean) => {
      const newGlobalFileIds = shouldBeGlobal
        ? [...globalSystemFileIds, fileId]
        : globalSystemFileIds.filter(id => id !== fileId);

      updateSettingsMutation.mutate(
        { key: 'SystemFiles' as SettingKey, value: newGlobalFileIds.join(',') },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['settings'] });
            toast.success(shouldBeGlobal ? 'Promoted to global system file' : 'Removed from global system files');
          },
        }
      );
    },
    [globalSystemFileIds, updateSettingsMutation, queryClient]
  );

  const sortedSystemFiles = useCallback((files: ISystemFileEntry[] | null = []): SystemFile[] => {
    if (!files || files.length === 0) return [];
    const uniqueFiles = files.reduce((acc, file) => {
      const filtered = acc.filter(f => f.fileId !== file.fileId);
      return [...filtered, file];
    }, [] as ISystemFileEntry[]);
    return [...uniqueFiles]
      .map(f => f as SystemFile)
      .sort((a, b) => {
        return (a.systemPriority || 0) - (b.systemPriority || 0);
      });
  }, []);

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const data = {
          type: KnowledgeType.FILE,
          fileName: file.name,
          mimeType: file.type,
          fileSize: file.size,
        };
        const newFile = await createFabFileOnServerWithUpload(data, file);
        addSystemPromptMutation.mutate(newFile.id);
        toast.success(`Uploaded: ${file.name}`);
      } catch (error) {
        console.error('Error uploading file %s:', file.name, error);
        toast.error(getErrorMessage(error));
      }
    }
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const openNewSystemFile = useCallback(() => {
    setSelectedFabFileId(null); // null triggers "new file" mode
    setViewOnly(false);
    setOpen(true);
  }, [setSelectedFabFileId, setOpen, setViewOnly]);

  const viewSystemFile = useCallback(
    (fileId: string) => {
      setSelectedFabFileId(fileId);
      setViewOnly(false);
      setOpen(true);
    },
    [setSelectedFabFileId, setOpen, setViewOnly]
  );

  return (
    <Box className="system-prompts-tab-root" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Current System Prompts Section */}
      <SectionContainer
        title="Current System Prompts"
        action={
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
            <Tooltip title="Create a File">
              <IconButton
                variant="outlined"
                color="primary"
                onClick={openNewSystemFile}
                disabled={isAnyOperationLoading}
                className="system-prompts-tab-create-button"
                sx={theme => ({
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '6px',
                  borderRadius: '8px',
                  color: 'text.primary',
                  width: '36px',
                  height: '36px',
                  flexShrink: 0,
                })}
              >
                <AutoFixHigh
                  sx={{ fontSize: '18px', color: 'text.primary' }}
                  className="system-prompts-tab-create-icon"
                />
              </IconButton>
            </Tooltip>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
              multiple
            />
            <IconButton
              variant="outlined"
              color="primary"
              onClick={() => fileInputRef.current?.click()}
              className="system-prompts-tab-upload-button"
              sx={theme => ({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4px 16px',
                borderRadius: '8px',
                gap: '8px',
                color: 'text.primary',
                height: '36px',
                flexShrink: 0,
              })}
            >
              <UploadFileIcon
                sx={{ fontSize: '18px', color: 'text.primary' }}
                className="system-prompts-tab-upload-icon"
              />
              <Typography level="body-sm" sx={{ color: 'text.primary' }} className="system-prompts-tab-upload-text">
                Upload Files
              </Typography>
            </IconButton>

            <IconButton
              variant="outlined"
              color="primary"
              onClick={() => setIsFileBrowserModalOpen(true)}
              className="system-prompts-tab-browse-button"
              sx={theme => ({
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '4px 16px',
                borderRadius: '8px',
                gap: '8px',
                color: 'text.primary',
                height: '36px',
                flexShrink: 0,
              })}
            >
              <FolderSharedIcon
                sx={{ fontSize: '18px', color: 'text.primary' }}
                className="system-prompts-tab-browse-icon"
              />
              <Typography level="body-sm" sx={{ color: 'text.primary' }} className="system-prompts-tab-browse-text">
                File Browser
              </Typography>
            </IconButton>
          </Box>
        }
      >
        <List className="system-prompts-tab-current-list" sx={{ gap: '15px' }}>
          {sortedSystemFiles(currentUser.systemFiles)?.map((file: SystemFile) => {
            const isToggling = isFileLoading('toggle', file.fileId);
            const isDeleting = isFileLoading('delete', file.fileId);
            return (
              <SystemPromptRow
                key={file.fileId}
                file={file}
                isAdmin={isAdmin}
                isToggling={isToggling}
                isDeleting={isDeleting}
                isDisabled={isAnyOperationLoading}
                onToggle={() => {
                  if (!isAnyOperationLoading) {
                    toggleMutation.mutate({
                      fileId: file.fileId,
                      enabled: !file.enabled,
                    });
                  }
                }}
                isGlobal={globalSystemFileIds.includes(file.fileId)}
                onView={() => {
                  if (!isAnyOperationLoading) {
                    viewSystemFile(file.fileId);
                  }
                }}
                onDelete={() => {
                  if (!isAnyOperationLoading) {
                    deleteSystemPromptMutation.mutate(file.fileId);
                  }
                }}
                onToggleGlobal={() => {
                  if (!isAnyOperationLoading) {
                    toggleGlobalSystemFile(file.fileId, !globalSystemFileIds.includes(file.fileId));
                  }
                }}
              />
            );
          })}
        </List>
      </SectionContainer>

      {/* File Browser Modal */}
      <Modal open={isFileBrowserModalOpen} onClose={() => setIsFileBrowserModalOpen(false)}>
        <ModalDialog
          sx={{
            maxWidth: '800px',
            width: '90vw',
            maxHeight: '80vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ModalClose />
          <Typography level="h3" sx={{ mb: 2 }}>
            Browse Available Files
          </Typography>

          {/* Search and Sort Controls */}
          <Box sx={{ display: 'flex', gap: 2, mb: 2 }}>
            <Input
              placeholder="Filter available files..."
              onChange={e => handleSearch(e.target.value)}
              startDecorator={<Search />}
              disabled={isAnyOperationLoading}
              sx={{ flex: 1 }}
            />
            <Select
              value={sortBy}
              onChange={handleSortChange}
              startDecorator={<Sort />}
              disabled={isAnyOperationLoading}
              sx={{ minWidth: 140 }}
            >
              {SORT_CONFIG.map(({ value, label }) => (
                <Option key={value} value={value}>
                  {label}
                </Option>
              ))}
            </Select>
          </Box>

          {/* Files List */}
          <Box sx={{ flex: 1, overflow: 'auto' }}>
            <List>
              {sortedFabFiles?.map(file => {
                const isAdding = isFileLoading('add', file.id);
                return (
                  <ListItem
                    key={file.id}
                    sx={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 2,
                      py: 1,
                      opacity: isAnyOperationLoading && !isAdding ? 0.6 : 1,
                      transition: 'opacity 0.2s ease-in-out',
                    }}
                  >
                    <Typography
                      sx={{
                        flex: 1,
                        fontWeight: isAdding ? 'md' : 'sm',
                        color: isAdding ? 'primary.main' : 'text.primary',
                      }}
                    >
                      {file.fileName}
                    </Typography>
                    <Button
                      size="sm"
                      variant="soft"
                      color="primary"
                      disabled={isAnyOperationLoading}
                      loading={isAdding}
                      onClick={() => {
                        if (!isAnyOperationLoading) {
                          addSystemPromptMutation.mutate(file.id);
                        }
                      }}
                      startDecorator={!isAdding ? <Add /> : undefined}
                      sx={{
                        minWidth: '160px',
                        transition: 'all 0.2s ease-in-out',
                      }}
                    >
                      {isAdding ? 'Adding...' : 'Add as System Prompt'}
                    </Button>
                  </ListItem>
                );
              })}
              {isFetching ? (
                <Box
                  sx={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    width: '100%',
                    height: '100px',
                  }}
                >
                  <CircularProgress />
                </Box>
              ) : (
                (!sortedFabFiles || sortedFabFiles.length === 0) && (
                  <Typography level="body-sm" sx={{ textAlign: 'center', color: 'neutral.500', py: 4 }}>
                    No available files found. Create a new file or upload one to add as a system prompt.
                  </Typography>
                )
              )}
            </List>
          </Box>
        </ModalDialog>
      </Modal>
    </Box>
  );
}

interface SystemPromptRowProps {
  file: SystemFile;
  isGlobal: boolean;
  isAdmin: boolean;
  isToggling: boolean;
  isDeleting: boolean;
  isDisabled: boolean;
  onToggle: () => void;
  onView: () => void;
  onDelete: () => void;
  onToggleGlobal: () => void;
}

const SystemPromptRow = memo<SystemPromptRowProps>(
  ({ file, isGlobal, isAdmin, isToggling, isDeleting, isDisabled, onToggle, onView, onDelete, onToggleGlobal }) => {
    const { data: fileInfo, isLoading } = useGetFabFile(file.fileId);

    if (!fileInfo || isLoading) return null;

    return (
      <ListItem
        key={file.fileId}
        sx={theme => ({
          ...cardSurfaceSx(theme),
          display: 'flex',
          width: '100%',
          alignItems: 'center',
          justifyContent: 'space-between',
          p: '20px', // override the helper's 16px - this row uses 20px padding
          opacity: isDisabled && !isToggling && !isDeleting ? 0.6 : 1,
          transition: 'all 0.2s ease-in-out',
          transform: isToggling || isDeleting ? 'scale(0.98)' : 'scale(1)',
        })}
      >
        {/* Left side: File Icon, Filename and Priority */}
        <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, gap: { xs: '8px', sm: '20px' } }}>
          <Box
            sx={theme => {
              const isImage = fileInfo?.mimeType?.startsWith('image/');
              const color = isImage ? '' : theme.palette.project?.fileIconColor;
              return {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                minWidth: 32,
                minHeight: 32,
                maxWidth: 32,
                maxHeight: 32,
                '& .MuiSvgIcon-root': {
                  color: theme.palette.fileBrowser?.fileIconColor || grayAlpha[210][50],
                },
                // Pass color to GetFileIcon below
                '--system-prompt-file-icon-color': color,
              };
            }}
          >
            <GetFileIcon
              file={fileInfo}
              size={32}
              previewSize={32}
              color={
                fileInfo?.mimeType?.startsWith('image/') ? '' : undefined // Will use CSS var from parent
              }
            />
          </Box>
          <Typography
            sx={theme => ({
              fontSize: { xs: '14px', sm: '16px' },
              lineHeight: { xs: '14px', sm: '16px' },
              color: 'text.primary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              flex: 1,
            })}
          >
            {fileInfo.fileName}
          </Typography>
          {isGlobal && (
            <Chip
              size="sm"
              variant="soft"
              sx={theme => ({
                bgcolor: theme.palette.fileBrowser.statusChip.backgroundColor,
                color: theme.palette.fileBrowser.statusChip.textColor,
                fontSize: '13px',
                height: '24px',
                maxWidth: '120px',
                border: `1px solid ${theme.palette.fileBrowser.statusChip.borderColor}`,
                ml: 1,
                mr: 1,
              })}
            >
              Global
            </Chip>
          )}
        </Box>

        {/* Right side: Controls */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: { xs: '8px', sm: '16px' },
            ml: 'auto',
            flexShrink: 0,
            position: 'relative',
          }}
        >
          {/* Loading indicator for toggle */}
          {isToggling && (
            <CircularProgress
              size="sm"
              sx={{
                position: 'absolute',
                left: '8px',
                top: '50%',
                transform: 'translateY(-50%)',
                zIndex: 1,
              }}
            />
          )}

          <Dropdown>
            <MenuButton
              slots={{ root: IconButton }}
              slotProps={{
                root: {
                  variant: 'outlined',
                  disabled: isDisabled,
                  sx: {
                    borderRadius: '8px',
                    width: 36,
                    height: 36,
                    minWidth: 36,
                    minHeight: 36,
                    maxWidth: 36,
                    maxHeight: 36,
                    p: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: isDeleting ? 0.5 : 1,
                    transition: 'opacity 0.2s ease-in-out',
                  },
                },
              }}
            >
              {isDeleting ? <CircularProgress size="sm" /> : <MoreVertIcon sx={{ fontSize: 20 }} />}
            </MenuButton>
            <Menu
              placement="bottom-end"
              sx={{
                minWidth: 120,
                zIndex: 1900,
                position: 'relative',
              }}
            >
              <MenuItem onClick={onToggleGlobal} disabled={isDisabled} sx={{ display: isAdmin ? 'flex' : 'none' }}>
                <PublicIcon />
                {isGlobal ? 'Remove from Global' : 'Promote to Global'}
              </MenuItem>
              <MenuItem
                onClick={onDelete}
                color="danger"
                disabled={isDisabled}
                sx={{
                  opacity: isDeleting ? 0.6 : 1,
                }}
              >
                {isDeleting ? (
                  <>
                    <CircularProgress size="sm" sx={{ mr: 1 }} />
                    Deleting...
                  </>
                ) : (
                  <>
                    <DeleteOutline sx={{ fontSize: '20px' }} />
                    Delete
                  </>
                )}
              </MenuItem>
            </Menu>
          </Dropdown>

          <IconButton
            variant="outlined"
            disabled={isDisabled}
            sx={{
              borderRadius: '8px',
              width: 36,
              height: 36,
              minWidth: 36,
              minHeight: 36,
              maxWidth: 36,
              maxHeight: 36,
              p: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onClick={onView}
          >
            <VisibilityOutlinedIcon sx={{ fontSize: 20 }} />
          </IconButton>

          <Box
            sx={theme => ({
              width: '1px',
              alignSelf: 'stretch',
              backgroundColor: theme.palette.project?.systemPromptModal?.backgroundColor || theme.palette.divider,
              mx: '8px',
            })}
          />
          <SquareSlideToggle checked={file.enabled} onChange={onToggle} disabled={isDisabled} />
        </Box>
      </ListItem>
    );
  }
);

SystemPromptRow.displayName = 'SystemPromptRow';
