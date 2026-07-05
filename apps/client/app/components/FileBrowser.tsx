import AddKnowledgeModal from '@client/app/components/Knowledge/AddKnowledgeModal';
import CreateKnowledge from '@client/app/components/Knowledge/CreateKnowledge';
import CreateKnowledgeFromUrl from '@client/app/components/Knowledge/CreateKnowledgeFromUrl';
import {
  useBulkDeleteFiles,
  useCreateFabFileWithUpload,
  useDeleteFile,
  useGetFabFile,
  useGetFabFiles,
} from '@client/app/hooks/data/fabFiles';
import { ISessionDocument, IUserDocument } from '@bike4mind/common';
import { IFabFileDocument } from '@bike4mind/common';
import {
  createFabFileOnServerWithUpload,
  getContentFromFabfile,
  getFabFileByIdFromServer,
  updateFileUtility,
} from '@client/app/utils/filesAPICalls';
import {
  ArrowUpward,
  CalendarMonth,
  InsertDriveFileOutlined,
  KeyboardArrowDown,
  Search,
  Share,
  Sort,
  SortByAlpha,
  Storage,
  ViewList,
  ViewModule,
} from '@mui/icons-material';
import CloseIcon from '@mui/icons-material/Close';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import FolderSharedIcon from '@mui/icons-material/FolderShared';
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Modal,
  ModalDialog,
  Option,
  Select,
  Sheet,
  Stack,
  Switch,
  Tab,
  TabList,
  Tabs,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import { debounce } from 'lodash';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useUser } from '../contexts/UserContext';
import FileStorageBar from './common/FileStorageBar';
import FileList from './FileList';
import { FileTagsModal } from './FileTagsModal';
import { useFileViewerStore } from './layouts/Notebook/Sidenav/FileViewerWrapper';
import { useShallow } from 'zustand/react/shallow';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { ProjectAddToModal } from '@client/app/components/Project/ProjectAddToModal';
import { useRemoveNonExistentFiles } from '@client/app/hooks/data/projects';
import { useSessions, useWorkBenchFiles, useWorkBenchActions } from '@client/app/contexts/SessionsContext';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { KnowledgeType } from '@bike4mind/common';
import { getErrorMessage } from '@client/app/utils/error';
import KnowledgeChunkControls from './Knowledge/KnowledgeChunkControls';
import { brand } from '@client/app/utils/themes/colors';
import DataLakeListPanel from './DataLakeWizard/DataLakeListPanel';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import StorageIcon from '@mui/icons-material/Storage';

interface FileBrowserProps {
  fabFiles?: IFabFileDocument[];
  totalFiles?: number;
  currentSession?: ISessionDocument | null;
  isFetching?: boolean;
  onFabFileClick: (file: IFabFileDocument) => void;
  openKnowledgeModal: (file: IFabFileDocument) => void;
  onFabFileDelete: (fileId: string, callback: (err?: Error) => void) => Promise<boolean>;
  canUpdate: (file: IFabFileDocument) => boolean;
  canDelete: (file: IFabFileDocument) => boolean;
  canShare: (file: IFabFileDocument) => boolean;
  onBulkDelete?: (fileIds: string[]) => Promise<void>;
  onBulkAdd: (files: IFabFileDocument[]) => void;
  onRefresh: () => Promise<void>;
  onScrollEnd: () => void;
  onPageChange?: (page: number) => void;
  currentPage?: number;
  totalPages?: number;
  hideButton?: boolean;
  className?: string;
  /**
   * Controls the open state of the FileBrowser modal. If not provided, internal state is used.
   */
  open?: boolean;
  /**
   * Callback fired when the open state should change (e.g., modal opened/closed). If not provided, internal state is used.
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Set of file IDs already added to the current project. When provided, files in this set
   * will show an "In Project" indicator in the FileBrowser.
   */
  addedFileIds?: Set<string>;
}

const FileBrowser = forwardRef<{ handleOpen: () => void }, FileBrowserProps>(
  (
    {
      isFetching,
      totalFiles = 0,
      fabFiles = [],
      currentSession,
      openKnowledgeModal,
      onBulkDelete,
      onBulkAdd,
      onRefresh,
      onScrollEnd,
      onPageChange,
      currentPage = 1,
      totalPages = 1,
      hideButton = false,
      open: controlledOpen,
      onOpenChange,
      addedFileIds,
    },
    ref
  ) => {
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const isControlled = controlledOpen !== undefined;
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const removeNonExistentFiles = useRemoveNonExistentFiles();
    const [search, sortOrder, filters, sortField] = useFileViewerStore(
      useShallow(s => [s.search, s.sort, s.filters, s.sortField])
    );
    const { type } = filters;

    // Use the same data source as FileList so handleBulkAdd filters the correct files
    const { data: internalFabFilesData } = useGetFabFiles(search, filters, sortOrder, sortField);
    const internalFabFiles = useMemo(
      () => internalFabFilesData?.pages?.flatMap((page: { data: IFabFileDocument[] }) => page.data) ?? [],
      [internalFabFilesData]
    );
    const [showAddKnowledgeModal, setShowAddKnowledgeModal] = useState(false);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('grid');
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const deleteFile = useDeleteFile();
    const bulkDeleteFiles = useBulkDeleteFiles();
    const createFabFileWithUpload = useCreateFabFileWithUpload();
    const [isLoading, setIsLoading] = useState(false);
    const [fileToShareId, setFileToShareId] = useState<string | null>(null);
    const { data: fileToShare } = useGetFabFile(fileToShareId);
    const { t } = useTranslation();
    const [tabIndex, setTabIndex] = React.useState(0);
    const [cloning, setCloning] = useState<boolean>(false);
    const [editMode, setEditMode] = useState<string | null>(null);
    const [editedFileName, setEditedFileName] = useState<string>('');
    const [fileToManageTags, setFileToManageTags] = useState<IFabFileDocument | null>(null);
    const [propertiesOpen, setPropertiesOpen] = useState(false);
    const [fileInPropertiesModal, setFileInPropertiesModal] = useState<IFabFileDocument | null>(null);
    const [showChunkModal, setShowChunkModal] = useState<boolean>(false);
    const [fileToChunk, setFileToChunk] = useState<IFabFileDocument | null>(null);
    const [openAddProjectModal, setOpenAddProjectModal] = useState<string | null>(null);
    const { setCurrentSession, currentSessionId } = useSessions();
    const workBenchFiles = useWorkBenchFiles(currentSessionId);
    const { setWorkBenchFiles } = useWorkBenchActions();
    const updateSession = useUpdateSession();

    const { currentUser, refreshUser } = useUser();
    const { serverSettings } = useServerSettings();
    const vectorThresholdSetting = serverSettings.find(
      (setting: { settingName: string; settingValue: string }) => setting.settingName === 'VectorThreshold'
    );
    const vectorThreshold = vectorThresholdSetting ? parseInt(vectorThresholdSetting.settingValue, 10) : 40000;

    const [isDragging, setIsDragging] = useState(false);
    const dragCounter = useRef(0);

    const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current++;
      if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
        setIsDragging(true);
      }
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter.current--;
      if (dragCounter.current === 0) {
        setIsDragging(false);
      }
    };

    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter.current = 0;

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await handleFiles(Array.from(e.dataTransfer.files));
        e.dataTransfer.clearData();
      }
    };

    const handleFiles = async (files: File[]) => {
      setCloning(true);
      for (const file of files) {
        try {
          const data = {
            type: KnowledgeType.FILE,
            fileName: file.name,
            mimeType: file.type,
            fileSize: file.size,
          };
          await createFabFileWithUpload(data, file);
          await onRefresh();
          await refreshUser();
          toast.success(`Uploaded: ${file.name}`);
        } catch (error) {
          console.error('Error uploading file %s:', file.name, error);
          toast.error(getErrorMessage(error));
          setCloning(false);
        }
      }
      setCloning(false);
    };

    const removeFromNotebook = useCallback(
      (fileIds: string[]) => {
        if (!fileIds.length) return;

        const updatedWorkBenchFiles = workBenchFiles.filter(file => !fileIds.includes(file.id));
        if (updatedWorkBenchFiles.length !== workBenchFiles.length) {
          setWorkBenchFiles(currentSessionId ?? '', updatedWorkBenchFiles);

          if (currentSession) {
            const updatedSession = {
              ...currentSession,
              knowledgeIds: updatedWorkBenchFiles.map(f => f.id),
            };
            setCurrentSession(updatedSession);
            updateSession.mutate(updatedSession);
          }
        }
      },
      [workBenchFiles, setWorkBenchFiles, currentSession, setCurrentSession, updateSession, currentSessionId]
    );

    const handleScrollEnd = useCallback(
      async (e: React.UIEvent<HTMLDivElement>) => {
        const element = e.target as HTMLDivElement;

        const value = Math.floor(element.scrollHeight - element.scrollTop);
        if (value + 2 >= element.clientHeight && value - 2 <= element.clientHeight) {
          onScrollEnd();
        }
      },
      [onScrollEnd]
    );

    const debounceFetch = useMemo(() => debounce(handleScrollEnd, 500), [handleScrollEnd]);

    useEffect(() => {
      if (isFetching || deleteFile.isPending || bulkDeleteFiles.isPending) {
        setIsLoading(true);
      } else {
        setIsLoading(false);
      }
    }, [isFetching, deleteFile.isPending, bulkDeleteFiles.isPending]);

    const toggleOpen = useCallback(
      (next: boolean) => {
        if (isControlled) {
          onOpenChange?.(next);
        } else {
          setUncontrolledOpen(next);
        }
      },
      [isControlled, onOpenChange]
    );

    const handleOpen = useCallback(async () => {
      toggleOpen(true);
      setSelectedFiles(new Set());
      setTabIndex(0);
      setEditMode(null);
      await onRefresh();
    }, [onRefresh, toggleOpen]);

    useImperativeHandle(ref, () => ({
      handleOpen,
    }));

    const handleSearch = useCallback((value: string) => {
      useFileViewerStore.setState(s => ({
        ...s,
        search: value,
        filters: {
          ...s.filters,
          tag: undefined, // Clear the tag filter as it's handled by the hook
        },
      }));
    }, []);

    const handleSetType = useCallback((value: string) => {
      useFileViewerStore.setState(s => ({
        ...s,
        filters: { ...s.filters, type: value ? (value as 'text' | 'pdf' | 'url' | 'image') : undefined },
      }));
    }, []);

    const handleClose = () => {
      useFileViewerStore.setState(s => ({
        ...s,
        search: '',
        filters: {},
      }));
      toggleOpen(false);
    };

    const toggleAddKnowledgeModal = () => {
      setShowAddKnowledgeModal(prev => !prev);
    };

    const toggleSortOrder = () => {
      useFileViewerStore.setState(s => ({ ...s, sort: s.sort === 'asc' ? 'desc' : 'asc' }));
    };

    const handleSetSortField = (field: string) => {
      useFileViewerStore.setState(s => ({ ...s, sortField: field }));
    };

    const toggleViewMode = () => {
      setViewMode(prev => (prev === 'list' ? 'grid' : 'list'));
    };

    const handleDelete = useCallback(
      async (fabFileId: string) => {
        deleteFile.mutate(fabFileId);

        removeFromNotebook([fabFileId]);

        setSelectedFiles(prev => {
          const newSet = new Set(prev);
          newSet.delete(fabFileId);
          return newSet;
        });
      },
      [deleteFile, removeFromNotebook]
    );

    const toggleFileSelection = useCallback((fileId: string) => {
      setSelectedFiles(prev => {
        const newSet = new Set(prev);
        if (newSet.has(fileId)) {
          newSet.delete(fileId);
        } else {
          newSet.add(fileId);
        }
        return newSet;
      });
    }, []);

    const handleBulkDelete = useCallback(async () => {
      if (selectedFiles.size === 0) {
        toast.error('Please select files to delete');
        return;
      }
      const tempSelectedFiles = Array.from(selectedFiles);

      try {
        if (onBulkDelete) {
          await onBulkDelete(tempSelectedFiles);
        } else {
          await bulkDeleteFiles.mutateAsync(tempSelectedFiles);
          await removeNonExistentFiles.mutateAsync(tempSelectedFiles);

          removeFromNotebook(tempSelectedFiles);
        }
      } catch (error) {
        console.log('failed to delete', error);
      }
      setSelectedFiles(new Set());
    }, [selectedFiles, onBulkDelete, removeNonExistentFiles, bulkDeleteFiles, removeFromNotebook]);

    const handleBulkAdd = useCallback(() => {
      if (selectedFiles.size === 0) {
        toast.error('Please select files to add');
        return;
      }
      const filesToAdd = internalFabFiles.filter(f => selectedFiles.has(f.id));
      onBulkAdd(filesToAdd);
      setSelectedFiles(new Set());
    }, [internalFabFiles, onBulkAdd, selectedFiles]);

    const onShare = useCallback((file: IFabFileDocument) => {
      setFileToShareId(file.id);
    }, []);

    const cloneFabFile = useCallback(
      async (file: IFabFileDocument) => {
        try {
          setCloning(true);
          if (!file || !file.fileUrl) return;

          // Always fetch from the API to refresh signed url
          const fullFabFile = await getFabFileByIdFromServer(file.id);
          if (!fullFabFile.fileUrl) {
            throw new Error('File URL not found');
          }

          const content = await getContentFromFabfile(fullFabFile);
          if (!content.ok) throw new Error('Failed to fetch file content');
          const blob = await content.blob();

          const newFile = new File([blob], 'Copy of ' + fullFabFile.fileName, { type: fullFabFile.mimeType });

          const data = {
            type: fullFabFile.type,
            fileName: newFile.name,
            mimeType: newFile.type,
            fileSize: newFile.size,
          };
          await createFabFileOnServerWithUpload(data, newFile);
          await onRefresh();
          toast.success(`Cloned file: "${file.fileName}" to "${newFile.name}".`);
        } catch (error: any) {
          console.error(error);
          toast.error('Failed to clone file.');
        } finally {
          setCloning(false);
        }
      },
      [onRefresh]
    );

    const handleRename = useCallback(
      async (file: IFabFileDocument) => {
        if (editMode === file.id) {
          try {
            // Server requires all fields alongside fileName
            await updateFileUtility(file.id, {
              fileName: editedFileName,
              mimeType: file.mimeType,
              filePath: file.filePath,
              fileSize: file.fileSize,
              type: file.type,
            });
            setEditMode(null);
            await onRefresh();
            toast.success(`Renamed file to "${editedFileName}".`);
          } catch (error: any) {
            console.error('Failed to rename file:', error);
            toast.error(`Failed to rename file: ${error?.message || ''}`);
          }
        } else {
          setEditMode(file.id);
          setEditedFileName(file.fileName);
        }
      },
      [editMode, editedFileName, onRefresh]
    );

    const openPropertiesModal = (file: IFabFileDocument) => {
      setFileInPropertiesModal(file);
      setPropertiesOpen(true);
    };

    const getSortIcon = (field: string) => {
      const iconStyle = { fontSize: '1.2rem', opacity: 0.5 };
      const icons = {
        createdAt: CalendarMonth,
        fileSize: Storage,
        fileName: SortByAlpha,
        default: Sort,
      };
      const Icon = icons[field as keyof typeof icons] || icons.default;
      return <Icon sx={iconStyle} />;
    };

    const handleOpenChunkModal = (file: IFabFileDocument) => {
      setFileToChunk(file);
      setShowChunkModal(true);
    };

    const renderTab = (index: number, icon: React.ReactElement, label: string) => (
      <Tab
        variant={tabIndex === index ? 'soft' : 'plain'}
        color={tabIndex === index ? 'primary' : 'secondary'}
        sx={{
          opacity: tabIndex === index ? 1 : 0.5,
        }}
      >
        {icon}
        <Typography sx={{ color: theme => theme.palette.text.primary }}>{label}</Typography>
      </Tab>
    );

    const renderSelect = ({
      placeholder,
      value,
      defaultValue,
      options,
      onChange,
      startDecorator,
      sx = {},
      'data-testid': dataTestId,
    }: {
      placeholder: string;
      value?: string;
      defaultValue?: string;
      options: { value: string; label: string }[];
      onChange: (value: string) => void;
      startDecorator?: React.ReactNode;
      sx?: any;
      'data-testid'?: string;
    }) => (
      <Select
        data-testid={dataTestId}
        placeholder={placeholder}
        value={value}
        defaultValue={defaultValue}
        onChange={(_, value) => onChange(value as string)}
        startDecorator={startDecorator}
        indicator={<KeyboardArrowDown />}
        sx={sx}
      >
        {options.map(option => (
          <Option key={option.value} value={option.value}>
            {option.label}
          </Option>
        ))}
      </Select>
    );

    const handleToggleSelectAll = () => {
      if (selectedFiles.size > 0) {
        setSelectedFiles(new Set());
      } else {
        const allFileIds = new Set(fabFiles.map(file => file.id));
        setSelectedFiles(allFileIds);
      }
    };

    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleBrowseClick = () => {
      fileInputRef.current?.click();
    };

    const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      if (files) {
        await handleFiles(Array.from(files));
      }
    };

    return (
      <>
        {!hideButton && (
          <Tooltip title={t('file_browser.browse_files')} placement="top">
            <IconButton
              variant="outlined"
              color="neutral"
              onClick={handleOpen}
              sx={{
                display: 'flex',
                alignItems: 'center',
                height: '50%',
                padding: {
                  xs: '4px',
                  sm: '6px 16px',
                },
                gap: '6px',
              }}
            >
              <FolderSharedIcon
                sx={{
                  fontSize: '18px',
                  marginRight: {
                    xs: 0,
                    sm: '5px',
                  },
                }}
              />
              <Typography
                sx={{
                  display: {
                    xs: 'none',
                    sm: 'inline',
                  },
                }}
              >
                {t('files.title')}
              </Typography>
            </IconButton>
          </Tooltip>
        )}
        <Modal
          aria-labelledby="file-browser-modal-title"
          open={open}
          onClose={handleClose}
          sx={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            width: '100vw',
            height: '100vh',
            '@media (max-width: 600px)': {
              alignItems: 'flex-start',
            },
            '& *': {
              color: theme => theme.palette.text.primary,
            },
          }}
        >
          <Sheet
            variant="outlined"
            data-testid="file-browser-modal"
            sx={theme => ({
              borderRadius: 'md',
              p: 3,
              boxShadow: 'lg',
              minWidth: '80vw',
              maxWidth: '80vw',
              minHeight: '80vh',
              maxHeight: '80vh',
              position: 'relative',
              display: 'flex',
              flexDirection: 'column',
              '@media (max-width: 600px)': {
                minWidth: '100vw',
                maxWidth: '100vw',
                minHeight: '100vh',
                maxHeight: '100vh',
                borderRadius: 0,
                p: 2,
              },
              border: '1px solid',
              borderColor: isDragging ? 'primary.main' : 'divider',
              transition: 'all 0.3s',
              bgcolor: isDragging ? 'action.hover' : theme.palette.background.surface,
            })}
            onDragEnter={handleDragEnter}
            onDragLeave={handleDragLeave}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
          >
            {isDragging && (
              <Box
                sx={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  bgcolor: 'action.hover',
                  zIndex: 1000,
                  borderRadius: 'inherit',
                }}
              >
                <Typography level="h4" sx={{ color: 'primary.main' }}>
                  {t('file_browser.drop_files_here')}
                </Typography>
              </Box>
            )}
            {/* Header Section */}
            <Box
              data-testid="file-browser-header"
              sx={{
                flexShrink: 0,
                display: 'flex',
                justifyContent: 'flex-end',
                position: 'absolute',
                top: 0,
                right: 0,
              }}
            >
              <IconButton
                variant="plain"
                data-testid="file-browser-close-btn"
                onClick={handleClose}
                sx={{
                  '& .MuiSvgIcon-root': {
                    fontSize: '1rem',
                  },
                }}
              >
                <CloseIcon />
              </IconButton>
            </Box>

            {/* Main content area with Tabs */}
            <Box
              data-testid="file-browser-content"
              sx={{
                display: 'flex',
                flexDirection: 'column',
                flexGrow: 1,
                minHeight: 0,
                overflow: 'hidden',
                position: 'relative',
                '@media (max-width: 600px)': {
                  paddingBottom: '56px',
                },
              }}
            >
              <Tabs
                aria-label="Outlined tabs"
                value={tabIndex}
                onChange={async (event, value) => {
                  if (value === 0) {
                    useFileViewerStore.setState({ filters: { ...filters, shared: undefined } });
                  } else {
                    useFileViewerStore.setState({ filters: { ...filters, shared: true } });
                  }

                  setSelectedFiles(new Set());

                  await onRefresh();

                  setTabIndex(value as number);

                  setEditMode(null);
                }}
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  height: '100%',
                  position: 'absolute',
                  inset: 0,
                  '@media (max-width: 600px)': {
                    '& .MuiTabPanel-root': {
                      p: 1,
                      pb: '56px',
                    },
                  },
                }}
              >
                <Box>
                  <TabList
                    sx={{
                      // Remove inherited border radius
                      '--List-radius': '0px',
                    }}
                  >
                    {renderTab(0, <InsertDriveFileOutlined />, t('file_browser.my_files'))}
                    {renderTab(1, <Share />, t('file_browser.shared_with_me'))}
                  </TabList>
                </Box>
                {/* Search and Controls Section */}
                <Stack
                  direction="column"
                  spacing={2}
                  mt={2}
                  mb={2}
                  sx={{
                    flexShrink: 0,
                    '@media (max-width: 600px)': {
                      '& > *': { width: '100%' },
                    },
                  }}
                >
                  {/* First row with total files and storage bar */}
                  <Box>
                    <Stack
                      direction={{ xs: 'column', md: 'row' }}
                      alignItems="center"
                      width="100%"
                      gap={{ xs: 1, md: 2 }}
                      justifyContent="space-between"
                      my={2}
                    >
                      <Box>
                        <Typography level="body-md">
                          {t('file_browser.total_files')}: {isLoading ? '...' : totalFiles}
                        </Typography>
                        <Typography level="body-sm" sx={{ opacity: 0.5, color: theme => theme.palette.text.primary }}>
                          {t('file_browser.select_file_hint')}
                        </Typography>
                      </Box>
                      <Box sx={{ width: { xs: '100%', md: '430px' } }}>
                        <FileStorageBar
                          currentStorageInBytes={currentUser?.currentStorageSize ?? 0}
                          storageLimitInBytes={(currentUser?.storageLimit ?? 1000) * 1000000}
                        />
                      </Box>
                    </Stack>
                  </Box>

                  {/* Second row with search and controls */}
                  <Stack direction={{ xs: 'column', md: 'row' }} sx={{ width: '100%', gap: { xs: 1, md: 2 } }}>
                    <Input
                      data-testid="file-browser-search-input"
                      className="file-browser-search-input"
                      startDecorator={<Search sx={{ opacity: 0.5 }} />}
                      defaultValue={search}
                      placeholder={t('file_browser.search_placeholder')}
                      onChange={e => handleSearch(e.target.value)}
                      sx={{ flexGrow: 1, backgroundColor: theme => theme.palette.searchbar.background }}
                    />

                    <Box
                      data-testid="file-browser-controls"
                      sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, md: 2 }, flexShrink: 0 }}
                    >
                      {renderSelect({
                        'data-testid': 'sidenav-file-type-filter',
                        placeholder: t('file_browser.file_type'),
                        value: type || '',
                        options: [
                          { value: '', label: t('file_browser.all_files') },
                          { value: 'text', label: t('file_browser.text') },
                          { value: 'pdf', label: t('file_browser.pdf') },
                          { value: 'url', label: t('file_browser.url') },
                          { value: 'image', label: t('file_browser.image') },
                          { value: 'excel', label: t('file_browser.excel') },
                          { value: 'word', label: t('file_browser.word') },
                          { value: 'json', label: t('file_browser.json') },
                          { value: 'csv', label: t('file_browser.csv') },
                          { value: 'markdown', label: t('file_browser.markdown') },
                          { value: 'code', label: t('file_browser.code') },
                        ],
                        onChange: handleSetType,
                        sx: { width: { xs: '100%', sm: 'auto' }, flexGrow: 1 },
                      })}
                      {renderSelect({
                        placeholder: t('sidenav.sessions.sort.label'),
                        defaultValue: 'createdAt',
                        options: [
                          { value: 'createdAt', label: t('file_browser.date_created') },
                          { value: 'fileSize', label: t('file_browser.size') },
                          { value: 'fileName', label: t('file_browser.name') },
                        ],
                        onChange: handleSetSortField,
                        startDecorator: getSortIcon(sortField),
                        sx: { width: { xs: '100%', sm: 'auto' }, minWidth: '140px' },
                      })}
                    </Box>

                    {/* Desktop Controls - Always visible */}
                    <Box
                      data-testid="file-browser-desktop-controls"
                      sx={{
                        display: { xs: 'none', md: 'flex' },
                        alignItems: 'center',
                        gap: { xs: '12px', md: '16px' },
                        flexShrink: 0,
                      }}
                    >
                      <Tooltip
                        title={sortOrder === 'asc' ? t('file_browser.sort_z_to_a') : t('file_browser.sort_a_to_z')}
                      >
                        <IconButton
                          data-testid="file-browser-sort-btn"
                          variant="outlined"
                          onClick={toggleSortOrder}
                          sx={{
                            transform: sortOrder === 'desc' ? 'rotate(180deg)' : 'none',
                            transition: 'transform 0.2s',
                          }}
                        >
                          <ArrowUpward />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={viewMode === 'list' ? t('file_browser.grid_view') : t('file_browser.list_view')}>
                        <IconButton
                          data-testid="file-browser-view-toggle-btn"
                          variant="outlined"
                          onClick={toggleViewMode}
                        >
                          {viewMode === 'list' ? <ViewModule /> : <ViewList />}
                        </IconButton>
                      </Tooltip>
                      <CreateKnowledge data-testid="file-browser-create-knowledge-btn" disabled={isLoading} />
                      <CreateKnowledgeFromUrl
                        data-testid="file-browser-create-knowledge-from-url-btn"
                        disabled={isLoading}
                      />
                      <IconButton
                        data-testid="file-browser-upload-btn"
                        variant="outlined"
                        color="primary"
                        onClick={handleBrowseClick}
                        disabled={cloning}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '6px 30px',
                          borderRadius: '8px',
                          borderColor: brand[800],
                        }}
                      >
                        {cloning ? (
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'center',
                              minWidth: '96px',
                              justifyContent: 'center',
                            }}
                          >
                            <CircularProgress size="sm" />
                          </Box>
                        ) : (
                          <>
                            <FileUploadIcon sx={{ fontSize: '18px', marginRight: '5px' }} />
                            <Typography>{t('projects.modals.files.button_label')}</Typography>
                          </>
                        )}
                      </IconButton>
                      <input
                        data-testid="file-browser-file-input"
                        type="file"
                        ref={fileInputRef}
                        style={{ display: 'none' }}
                        onChange={handleFileSelect}
                        multiple
                      />
                      <CreateDataLakeButton />
                    </Box>

                    {/* Mobile Accordion */}
                    <MobileControlsAccordion
                      t={t}
                      sortOrder={sortOrder}
                      toggleSortOrder={toggleSortOrder}
                      viewMode={viewMode}
                      toggleViewMode={toggleViewMode}
                      isLoading={isLoading}
                      cloning={cloning}
                      handleBrowseClick={handleBrowseClick}
                      fileInputRef={fileInputRef}
                      handleFileSelect={handleFileSelect}
                    />
                  </Stack>
                </Stack>
                <Box
                  sx={{
                    flexGrow: 1,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    position: 'relative',
                  }}
                  onScroll={debounceFetch}
                >
                  <Box
                    sx={{
                      flexGrow: 1,
                      overflow: 'hidden',
                      display: 'flex',
                      flexDirection: 'column',
                      position: 'relative',
                      mt: 2,
                    }}
                  >
                    <FileList
                      tabIndex={tabIndex}
                      totalFiles={totalFiles}
                      fileList={fabFiles}
                      viewMode={viewMode}
                      isLoading={isLoading}
                      selectedFiles={selectedFiles}
                      handleBulkAdd={handleBulkAdd}
                      handleBulkDelete={handleBulkDelete}
                      fileToShare={fileToShare as IFabFileDocument}
                      setFileToShare={fab => setFileToShareId(fab?.id ?? null)}
                      currentUser={currentUser as IUserDocument}
                      currentSession={currentSession ?? null}
                      onSelect={(id: string) => toggleFileSelection(id)}
                      onShare={(file: IFabFileDocument) => onShare(file)}
                      onUnselectAll={handleToggleSelectAll}
                      onFileScrolled={debounceFetch}
                      vectorThreshold={vectorThreshold}
                      handleRename={handleRename}
                      handleDelete={handleDelete}
                      cloneFabFile={cloneFabFile}
                      cloning={cloning}
                      openKnowledgeModal={openKnowledgeModal}
                      setFileToManageTags={setFileToManageTags}
                      openPropertiesModal={openPropertiesModal}
                      handleOpenChunkModal={handleOpenChunkModal}
                      setOpenAddProjectModal={setOpenAddProjectModal}
                      editMode={editMode}
                      editedFileName={editedFileName}
                      setEditedFileName={setEditedFileName}
                      setEditMode={setEditMode}
                      onRefresh={onRefresh}
                      addedFileIds={addedFileIds}
                    />
                    {/* Pagination Controls */}
                    {onPageChange && totalPages > 1 && (
                      <Box
                        data-testid="file-browser-pagination"
                        sx={{
                          display: 'flex',
                          justifyContent: 'center',
                          alignItems: 'center',
                          gap: 2,
                          mt: 2,
                          pb: 2,
                        }}
                      >
                        <Button
                          data-testid="file-browser-pagination-prev"
                          variant="outlined"
                          disabled={currentPage === 1 || isLoading}
                          onClick={() => onPageChange(currentPage - 1)}
                          size="sm"
                        >
                          {t('file_browser.previous')}
                        </Button>
                        <Typography level="body-sm">
                          {t('file_browser.page_of', { current: currentPage, total: totalPages })}
                        </Typography>
                        <Button
                          data-testid="file-browser-pagination-next"
                          variant="outlined"
                          disabled={currentPage === totalPages || isLoading}
                          onClick={() => onPageChange(currentPage + 1)}
                          size="sm"
                        >
                          {t('file_browser.next')}
                        </Button>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Tabs>
            </Box>
          </Sheet>
        </Modal>
        {showAddKnowledgeModal && <AddKnowledgeModal open={showAddKnowledgeModal} onClose={toggleAddKnowledgeModal} />}
        {/* DataLakeWizardModal is a global singleton mounted once via ProviderBundle
            (Files/Browser.tsx) and driven by useDataLakeWizardStore — mounting it here
            too produced a second, stacked wizard. */}
        {fileToManageTags && (
          <FileTagsModal
            open={!!fileToManageTags}
            onClose={() => setFileToManageTags(null)}
            file={fileToManageTags}
            onRefresh={onRefresh}
          />
        )}
        {propertiesOpen && (
          <Modal
            open={propertiesOpen}
            onClose={() => setPropertiesOpen(false)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Sheet
              variant="outlined"
              sx={{
                minWidth: 400,
                borderRadius: 'md',
                p: 3,
                boxShadow: 'lg',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                '@media (max-width: 600px)': {
                  minWidth: '90%',
                  maxWidth: '90%',
                  p: 2,
                },
              }}
            >
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography level="h4">{t('file_properties.title')}</Typography>
                <IconButton onClick={() => setPropertiesOpen(false)} variant="plain" size="sm">
                  <CloseIcon />
                </IconButton>
              </Box>

              <FormControl>
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
                  <FormLabel>{t('file_properties.make_instructions')}</FormLabel>
                  <Switch
                    checked={!!fileInPropertiesModal?.system}
                    onChange={e => {
                      setFileInPropertiesModal(prev => (prev ? { ...prev, system: e.target.checked } : prev));
                    }}
                  />
                </Stack>
              </FormControl>

              <FormControl>
                <FormLabel>{t('file_properties.instruction_priority')}</FormLabel>
                <Input
                  type="number"
                  disabled={!fileInPropertiesModal?.system}
                  value={fileInPropertiesModal?.systemPriority ?? 999}
                  onChange={e => {
                    const val = parseInt(e.target.value, 10);
                    setFileInPropertiesModal(prev => (prev ? { ...prev, systemPriority: val } : prev));
                  }}
                  slotProps={{
                    input: {
                      min: 0,
                      max: 999,
                    },
                  }}
                />
                <Typography level="body-xs" sx={{ mt: 0.5, color: 'neutral.500' }}>
                  {t('file_properties.priority_levels.global')}
                  <br />
                  {t('file_properties.priority_levels.group')}
                  <br />
                  {t('file_properties.priority_levels.project')}
                  <br />
                  {t('file_properties.priority_levels.user')}
                </Typography>
              </FormControl>

              <FormControl>
                <FormLabel>{t('file_actions.notes')}</FormLabel>
                <Textarea
                  minRows={3}
                  value={fileInPropertiesModal?.notes ?? ''}
                  onChange={e => {
                    setFileInPropertiesModal(prev => (prev ? { ...prev, notes: e.target.value } : prev));
                  }}
                  placeholder={t('file_actions.notes_placeholder')}
                />
              </FormControl>

              <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
                <Button variant="plain" color="neutral" onClick={() => setPropertiesOpen(false)}>
                  {t('add_friend.cancel')}
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      if (!fileInPropertiesModal) return;
                      await updateFileUtility(fileInPropertiesModal.id, {
                        ...fileInPropertiesModal,
                      });
                      await onRefresh();
                      toast.success(t('file_properties.update_success', { fileName: fileInPropertiesModal.fileName }));
                    } catch (error: any) {
                      console.error(error);
                      toast.error(t('file_properties.update_error'));
                    } finally {
                      setPropertiesOpen(false);
                    }
                  }}
                >
                  {t('file_properties.save')}
                </Button>
              </Box>
            </Sheet>
          </Modal>
        )}
        <Modal open={showChunkModal} onClose={() => setShowChunkModal(false)}>
          <ModalDialog>
            <IconButton
              data-testid="chunk-modal-close-btn"
              variant="plain"
              color="neutral"
              onClick={() => setShowChunkModal(false)}
              sx={{ position: 'absolute', top: 8, right: 8 }}
            >
              <CloseIcon />
            </IconButton>

            <KnowledgeChunkControls fabFile={fileToChunk} />
          </ModalDialog>
        </Modal>
        <ProjectAddToModal
          dataId={openAddProjectModal || ''}
          dataType="file"
          open={!!openAddProjectModal}
          setOpen={open => setOpenAddProjectModal(open ? openAddProjectModal : null)}
        />
      </>
    );
  }
);

FileBrowser.displayName = 'FileBrowser';

function CreateDataLakeButton() {
  const { isFeatureEnabled } = useAdminSettingsCache();
  const [managerOpen, setManagerOpen] = useState(false);

  // Server gates every /api/data-lakes endpoint on EnableDataLakes; hide the entry
  // point too when the feature is off so we don't surface a panel that 403s.
  if (!isFeatureEnabled('EnableDataLakes')) return null;

  return (
    <>
      <Tooltip title="Manage data lakes — bulk-ingest folders of files">
        <IconButton
          data-testid="file-browser-create-data-lake-btn"
          variant="outlined"
          color="primary"
          onClick={() => setManagerOpen(true)}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6px 30px',
            borderRadius: '8px',
            borderColor: brand[800],
          }}
        >
          <StorageIcon sx={{ fontSize: '18px', marginRight: '5px' }} />
          <Typography>Data Lake</Typography>
        </IconButton>
      </Tooltip>

      {/* Management surface: lists lakes + lifecycle (archive/restore/delete/purge);
          its internal "Create" button opens the wizard (DataLakeWizardModal, mounted below). */}
      <Modal open={managerOpen} onClose={() => setManagerOpen(false)}>
        <ModalDialog
          data-testid="data-lake-manager-modal"
          sx={{ width: { xs: '95%', sm: '32rem' }, maxWidth: '32rem', maxHeight: '85vh', overflow: 'auto', p: 0 }}
        >
          <DataLakeListPanel />
        </ModalDialog>
      </Modal>
    </>
  );
}

const MobileControlsAccordion: React.FC<{
  t: any;
  sortOrder: string;
  toggleSortOrder: () => void;
  viewMode: string;
  toggleViewMode: () => void;
  isLoading: boolean;
  cloning: boolean;
  handleBrowseClick: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  handleFileSelect: (event: React.ChangeEvent<HTMLInputElement>) => void;
}> = ({
  t,
  sortOrder,
  toggleSortOrder,
  viewMode,
  toggleViewMode,
  isLoading,
  cloning,
  handleBrowseClick,
  fileInputRef,
  handleFileSelect,
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <Box sx={{ display: { xs: 'block', md: 'none' } }}>
      {/* Accordion Header */}
      <Box
        data-testid="mobile-controls-accordion-header"
        onClick={() => setExpanded(!expanded)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          backgroundColor: 'background.surface',
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '8px',
          cursor: 'pointer',
          '&:hover': {
            backgroundColor: 'background.level1',
          },
          height: '40px',
        }}
      >
        <Typography level="body-sm" sx={{ fontWeight: 500 }}>
          More
        </Typography>
        <Box
          data-testid="mobile-controls-accordion-arrow"
          sx={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}
        >
          <KeyboardArrowDown />
        </Box>
      </Box>

      {/* Accordion Content */}
      {expanded && (
        <Box
          data-testid="mobile-controls-accordion-content"
          sx={{
            padding: '16px',
            backgroundColor: 'background.surface',
            border: '1px solid',
            borderColor: 'divider',
            borderTop: 'none',
            borderRadius: '0 0 8px 8px',
            marginTop: '-1px',
          }}
        >
          {/* View Controls */}
          <Box sx={{ marginBottom: '16px' }}>
            <Stack direction="row" gap="8px" sx={{ justifyContent: 'center' }}>
              <Tooltip title={sortOrder === 'asc' ? t('file_browser.sort_z_to_a') : t('file_browser.sort_a_to_z')}>
                <IconButton
                  data-testid="mobile-sort-btn"
                  variant="outlined"
                  onClick={toggleSortOrder}
                  sx={{
                    transform: sortOrder === 'desc' ? 'rotate(180deg)' : 'none',
                    transition: 'transform 0.2s',
                    minWidth: '44px',
                    height: '44px',
                  }}
                >
                  <ArrowUpward />
                </IconButton>
              </Tooltip>
              <Tooltip title={viewMode === 'list' ? t('file_browser.grid_view') : t('file_browser.list_view')}>
                <IconButton
                  data-testid="mobile-view-toggle-btn"
                  variant="outlined"
                  onClick={toggleViewMode}
                  sx={{
                    minWidth: '44px',
                    height: '44px',
                  }}
                >
                  {viewMode === 'list' ? <ViewModule /> : <ViewList />}
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>

          {/* Create Actions */}
          <Box>
            <Stack direction="column" gap="8px">
              <CreateKnowledge disabled={isLoading} />
              <CreateKnowledgeFromUrl disabled={isLoading} />
              <IconButton
                data-testid="mobile-upload-btn"
                variant="outlined"
                color="primary"
                onClick={handleBrowseClick}
                disabled={cloning}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '12px 16px',
                  borderRadius: '8px',
                  borderColor: brand[800],
                  minHeight: '32px',
                  height: '32px',
                  width: '100%',
                }}
              >
                {cloning ? (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      minWidth: '96px',
                      justifyContent: 'center',
                    }}
                  >
                    <CircularProgress size="sm" />
                  </Box>
                ) : (
                  <>
                    <FileUploadIcon sx={{ fontSize: '18px', marginRight: '5px' }} />
                    <Typography sx={{ fontSize: '14px' }}>{t('projects.modals.files.button_label')}</Typography>
                  </>
                )}
              </IconButton>
            </Stack>
          </Box>
          <input type="file" ref={fileInputRef} style={{ display: 'none' }} onChange={handleFileSelect} multiple />
        </Box>
      )}
    </Box>
  );
};

export default FileBrowser;
