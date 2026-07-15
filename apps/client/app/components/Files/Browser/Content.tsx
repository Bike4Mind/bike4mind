import { IFabFileDocument, InviteType, KnowledgeType } from '@bike4mind/common';
import { useSessions, useWorkBenchFiles, useWorkBenchStore } from '@client/app/contexts/SessionsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useLLM } from '@client/app/contexts/LLMContext';
import {
  ISearchFabFilesParams,
  useBulkDeleteFiles,
  useCreateFabFile,
  usePaginatedSearchFabFiles,
  useSearchFabFiles,
} from '@client/app/hooks/data/fabFiles';
import { useModelInfo } from '@client/app/hooks/data/useModelInfo';
import { useUpdateSession } from '@client/app/hooks/data/sessions';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import { useGetFileTags, useToggleTagToFiles, useCreateFileTag } from '@client/app/hooks/data/tag';
import { useConfirmation } from '@client/app/hooks/useConfirmation';
import { MobileTopBar } from '@client/app/components/MobileTopBar';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import { Box, Button, Chip, Typography, Modal, ModalDialog, ModalClose, Stack } from '@mui/joy';
import { FieldTooltip } from '@client/app/components/help';
import { FC, useState, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import FileStorageBar from '../../common/FileStorageBar';
import ShareDocumentModal from '../../common/ShareModal';
import CreateKnowledgeFromUrl from '../../Knowledge/CreateKnowledgeFromUrl';
import { useKnowledgeModal } from '../../Knowledge/KnowledgeModal';
import TagForm from '../../Tag/Form';
import { useFileBrowserInstance } from './instanceContext';
import FileBrowserActions from './Actions';
import FileBrowserFilter from './Filter';
import FileBrowserList from './List';
import ResearchEngineModal from '../../ResarchEngine/Modal';
import FileBrowserViewActions, { ViewMode } from './ViewActions';
import TagSidebar from './TagSidebar';
import { TagViewPanel } from './TagView';
import { HomeViewPanel } from './HomeView';
import { MobileSearchFilter } from './MobileSearchFilter';
import { useAddFilesToProject } from '@client/app/hooks/data/projects';
import { UploadActionsSelect } from './UploadActionsSelect';
import { useDataLakeWizardStore } from '@client/app/stores/useDataLakeWizardStore';
import { useAdminSettingsCache } from '@client/app/hooks/useAdminSettingsCache';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useQueryClient } from '@tanstack/react-query';

// Pagination constants
const FILES_PER_PAGE = 20;

const FileBrowserContent = () => {
  const { t } = useTranslation();
  const { currentUser } = useUser();
  const confirm = useConfirmation();
  const { selectedIds, setSelectedIds, setOpen, fileToShare, setFileToShare } = useFileBrowserInstance();
  const [showBulkShareModal, setShowBulkShareModal] = useState(false);
  const model = useLLM(state => state.model);
  const { data: modelInfo } = useModelInfo();
  const { isFeatureEnabled } = useFeatureEnabled();
  const isResearchEngineFeatureEnabled = isFeatureEnabled('enableResearchEngine');

  const openDataLakeManager = useDataLakeWizardStore(s => s.openManager);
  // Admin flag (useAdminSettingsCache), distinct from the experimental-features
  // isFeatureEnabled above: hide the Data Lakes manager entry when the feature is
  // off, matching the rest of the data-lake surface (CreateDataLakeButton etc).
  const { isFeatureEnabled: isAdminFeatureEnabled } = useAdminSettingsCache();

  // WebSocket subscription for real-time file vectorization updates
  const { subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();

  // Tag sidebar state
  const [isTagSidebarOpen, setIsTagSidebarOpen] = useState(false);

  // Tag creation modal state
  const [showTagModal, setShowTagModal] = useState(false);

  const { mutateAsync: createTag, isPending: isPendingCreateTag } = useCreateFileTag();

  const { currentSessionId, currentSession } = useSessions();
  const workBenchFiles = useWorkBenchFiles(currentSessionId);
  const updateSession = useUpdateSession();
  const [filter, setFilter] = useState<ISearchFabFilesParams>({});

  const [tagViewInitialNamespace, setTagViewInitialNamespace] = useState<string | undefined>();
  const [navigatedFromTags, setNavigatedFromTags] = useState(false);

  const [viewAction, setViewActions] = useState<{
    viewMode?: ViewMode;
    order?: ISearchFabFilesParams['order'];
  }>({
    order: {
      by: 'fileName',
      direction: 'asc',
    },
    viewMode: 'home',
  });
  const [sortField, setSortField] = useState<'fileName' | 'fileSize' | 'createdAt'>('createdAt');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Upload functionality
  const createFile = useCreateFabFile();
  const [openUrlModal, setOpenUrlModal] = useState(false);
  const [setKnowledgeOpen, setSelectedFabFileId, setViewOnly] = useKnowledgeModal(
    useShallow(state => [state.setOpen, state.setSelectedFabFileId, state.setViewOnly] as const)
  );

  const [currentPage, setCurrentPage] = useState(1);

  const {
    data,
    isLoading: isLoadingAllFiles,
    isFetching,
  } = usePaginatedSearchFabFiles({
    ...filter,
    order: { by: sortField, direction: sortDirection },
    page: currentPage,
  });

  // Overview tab renders its own "Recent" list (separate from the paginated allFiles
  // list below), so it's only fetched while that tab is active.
  const { data: recentData, isLoading: isLoadingRecent } = useSearchFabFiles(
    { order: { by: 'createdAt', direction: 'desc' }, pagination: { page: 1, limit: 8 } },
    { enabled: viewAction.viewMode === 'home' }
  );
  const recentFiles = recentData?.data?.slice(0, 8) || [];

  const { mutateAsync: toggleTagToFiles } = useToggleTagToFiles();
  const { data: fileTags } = useGetFileTags();
  const { mutateAsync: deleteFiles } = useBulkDeleteFiles();

  const availableOptions = fileTags?.filter(tag => !filter.filters?.tags?.includes(tag.name)) || [];

  const hasFilters = filter.search || filter.filters?.tags?.length || filter.filters?.type;

  const allFiles = data?.data || [];
  const totalFiles = data?.total || 0;
  const totalPages = Math.ceil(totalFiles / FILES_PER_PAGE);
  const { mutate: addFilesToProject } = useAddFilesToProject();

  // What Select All should select for the currently active tab: the Overview tab only
  // ever shows the "Recent" files, not the full paginated list.
  const selectableFiles = viewAction.viewMode === 'home' ? recentFiles : allFiles;

  // Selection is shared global state that persists across tab switches, but Overview
  // ("recent") and List/Grid ("paginated") show different file sets - carrying a
  // selection across that boundary produces a count/checkmarks that don't match what's
  // visible. Clear on crossing that boundary, but not when merely toggling List<->Grid,
  // which show the same underlying list and where a persisted selection is useful.
  const selectionScope = viewAction.viewMode === 'home' ? 'recent' : 'paginated';
  const selectionScopeRef = useRef(selectionScope);
  useEffect(() => {
    if (selectionScopeRef.current !== selectionScope) {
      setSelectedIds(new Set<string>());
      selectionScopeRef.current = selectionScope;
    }
  }, [selectionScope, setSelectedIds]);

  // Files can be selected from either list (Overview's recentFiles or the paginated
  // allFiles), so bulk actions must resolve selections against both, not just allFiles.
  const filesById = useMemo(() => {
    const m = new Map<string, IFabFileDocument>();
    for (const f of allFiles) m.set(f.id, f);
    for (const f of recentFiles) m.set(f.id, f);
    return m;
  }, [allFiles, recentFiles]);
  const selectedFiles = Array.from(selectedIds)
    .map(id => filesById.get(id))
    .filter((f): f is IFabFileDocument => Boolean(f));

  // Subscribe to WebSocket updates for file vectorization status
  useEffect(() => {
    const unsubscribe = subscribeToAction('update_file_chunk_vector_status', async msg => {
      if (msg.action !== 'update_file_chunk_vector_status') return;

      // Invalidate fabFiles queries to trigger a refetch and update the UI
      queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
    });

    return () => {
      unsubscribe();
    };
  }, [subscribeToAction, queryClient]);

  // Subscribe to WebSocket updates for the async upload content-moderation scan.
  // Flips a file's "Scanning..." placeholder to the real image (or blocked message) once the
  // scan resolves, mirroring the vectorization-status subscription above.
  useEffect(() => {
    const unsubscribe = subscribeToAction('image_moderation_status', async msg => {
      if (msg.action !== 'image_moderation_status') return;

      queryClient.invalidateQueries({ queryKey: ['fabFiles'], exact: false });
    });

    return () => {
      unsubscribe();
    };
  }, [subscribeToAction, queryClient]);

  const handleSortChange = (field: 'fileName' | 'fileSize' | 'createdAt', direction: 'asc' | 'desc') => {
    setSortField(field);
    setSortDirection(direction);
    setCurrentPage(1);
  };

  function handleSelectAll() {
    if (selectedIds.size > 0) {
      setSelectedIds(new Set<string>());
      return;
    }
    setSelectedIds(new Set(selectableFiles.map(f => f.id)));
  }

  function handleAdd() {
    const { setWorkBenchFiles } = useWorkBenchStore.getState();

    const applicableFiles = selectedFiles.filter(f => !workBenchFiles.some(w => w.id === f.id));

    // Check if any images are too large for current model (legacy files only)
    const currentModelInfo = modelInfo?.find(m => m.id === model);
    const modelBackend = currentModelInfo?.backend;
    const MAX_IMAGE_SIZE_MB = 3.5;

    // Models that require base64 encoding (have size limits)
    if (
      modelBackend &&
      (modelBackend.includes('anthropic') || modelBackend.includes('gemini') || modelBackend === 'bedrock')
    ) {
      // Check for oversized images first
      const oversizedImage = applicableFiles.find(fabFile => {
        if (fabFile.mimeType?.startsWith('image/')) {
          const fileSizeMB = fabFile.fileSize / (1024 * 1024);
          return fileSizeMB > MAX_IMAGE_SIZE_MB;
        }
        return false;
      });

      if (oversizedImage) {
        const fileSizeMB = oversizedImage.fileSize / (1024 * 1024);
        toast.error(
          `⚠️ Image "${oversizedImage.fileName}" (${fileSizeMB.toFixed(1)}MB) is too large for ${modelBackend.toUpperCase()}\n\nMax: 3.5MB. Delete this file and re-upload to auto-resize.`,
          { duration: 8000 }
        );
        return;
      }
    }

    const fileNames = applicableFiles.map(f => f.fileName).join(', ');
    const newWorkBenchFiles = [...workBenchFiles, ...applicableFiles];
    const knowledgeIds = newWorkBenchFiles.map(f => f.id);
    const projectsPageOpen = window.location?.pathname.includes('/projects');
    const projectId = window.location?.pathname.split('/').pop();

    // Optimistic update
    setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);

    if (currentSession) {
      updateSession.mutate(
        { ...currentSession, knowledgeIds },
        {
          onSuccess: () => {
            setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);
            toast.success(
              t('file_browser.add_to_session_success', {
                fileNames,
                sessionName: formatSessionTitle(currentSession.name),
              })
            );
          },
        }
      );
    }
    // if projects page is open, add files to project
    if (projectsPageOpen) {
      const projectKnowledgeIds = applicableFiles.map(f => f.id);
      addFilesToProject({ projectId: projectId ?? '', fileIds: projectKnowledgeIds });
      // no toast since addFilesToProject already has a toast
    }
    // if nothing else, add to workbench
    else {
      toast.success(t('file_browser.add_file_success', { fileNames }));
    }

    setSelectedIds(new Set<string>());
    setOpen(false);
  }

  async function handleDelete() {
    // Partition selected files into owned vs shared
    const ownedCount = selectedFiles.filter(f => f.userId === currentUser?.id).length;
    const sharedCount = selectedFiles.filter(f => f.userId !== currentUser?.id).length;

    let title: string;
    let description: string;
    let type: 'danger' | 'warning' = 'danger';

    if (sharedCount === 0) {
      title = `Delete ${ownedCount} file(s)`;
      description = 'Are you sure you want to delete these files?';
    } else if (ownedCount === 0) {
      title = `Remove ${sharedCount} shared file(s)`;
      description =
        "You will be removed from the share list for these files. They will no longer appear in your browser. The owners' copies are not affected.";
      type = 'warning';
    } else {
      title = `Delete ${ownedCount} file(s) and remove ${sharedCount} shared file(s)`;
      description = `This will delete ${ownedCount} file(s) you own and remove ${sharedCount} shared file(s) from your view. The shared files' owners are not affected.`;
    }

    confirm({
      title,
      description,
      type,
      onOk: async () => {
        await deleteFiles(Array.from(selectedIds));
        setSelectedIds(new Set<string>());
      },
    });
  }

  function handleFilterChange(filter: ISearchFabFilesParams) {
    setFilter(filter);
    setCurrentPage(1);
    setSelectedIds(new Set<string>());

    // Auto-switch to list view when filters are applied from Home or Tags
    const hasActiveFilters = filter.search || filter.filters?.tags?.length || filter.filters?.type;
    if (hasActiveFilters && (viewAction.viewMode === 'home' || viewAction.viewMode === 'tags')) {
      setViewActions({ ...viewAction, viewMode: 'list' });
    }
  }

  function handleBulkShare() {
    if (selectedIds.size === 0) {
      toast.error('Please select files to share');
      return;
    }
    setShowBulkShareModal(true);
  }

  function handleFileFilterChange(filterType: 'all' | 'shared' | 'curated') {
    handleFilterChange({
      ...filter,
      filters: {
        ...(filter.filters || {}),
        shared: filterType === 'shared' ? true : undefined,
        curated: filterType === 'curated' ? true : undefined,
      },
    });
  }

  // Upload handlers for mobile
  const handleUploadFiles = (files: File[]) => {
    createFile.mutate(
      files.map(file => ({
        file,
        type: KnowledgeType.FILE,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      }))
    );
  };

  const handleAddFromUrl = () => {
    setOpenUrlModal(true);
  };

  const handleCreateKnowledge = () => {
    setSelectedFabFileId(null);
    setViewOnly(false);
    setKnowledgeOpen(true);
  };

  const isLoading = isLoadingAllFiles;

  // Add handler for tag sidebar actions
  const handleTagSidebarClick = (tagName: string) => {
    const currentTags = filter.filters?.tags || [];
    const isTagActive = currentTags.includes(tagName);

    if (isTagActive) {
      // Remove tag from filter
      handleFilterChange({
        ...filter,
        filters: {
          ...(filter.filters || {}),
          tags: currentTags.filter(t => t !== tagName),
        },
      });
    } else {
      // Add tag to filter
      handleFilterChange({
        ...filter,
        filters: {
          ...(filter.filters || {}),
          tags: [...currentTags, tagName],
        },
      });
    }
  };

  // Add handler for clearing all active tags
  const handleClearAllTags = () => {
    handleFilterChange({
      ...filter,
      filters: {
        ...(filter.filters || {}),
        tags: [],
      },
    });
  };

  const handleAddTagToFiles = async (tagId: string, fileIds: string[]) => {
    try {
      const tag = fileTags?.find(t => t.id === tagId);
      if (!tag) return;

      await toggleTagToFiles({
        ids: fileIds,
        tags: [tag],
      });
      // Success/error toasts are owned by useToggleTagToFiles; no local toast here (avoids duplicates).
    } catch (error) {
      console.error('Failed to add tag to files:', error);
    }
  };

  const handleCreateTagFromSidebar = () => {
    setShowTagModal(true);
  };

  return (
    <>
      <Box
        className="file-browser-content-container"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: { xs: '8px', md: '20px' },
          height: '100%',
          justifyContent: 'space-between',
          padding: { xs: '0', md: '32px 32px 0 32px' },
          filter: isTagSidebarOpen ? 'blur(2px)' : 'none',
          backgroundColor: theme => theme.palette.background.body,
        }}
      >
        <Box sx={{ display: { xs: 'block', md: 'none' } }}>
          <MobileTopBar
            title="File Browser"
            onClose={() => setOpen(false)}
            rightContent={
              <Button
                onClick={() => setIsTagSidebarOpen(!isTagSidebarOpen)}
                variant="outlined"
                color="neutral"
                startDecorator={<LocalOfferIcon />}
                sx={{
                  minHeight: '32px',
                  px: 2,
                  py: 0,
                  color: 'text.primary',
                  fontSize: '14px',
                  fontWeight: '400',
                  '& .MuiSvgIcon-root': {
                    fontSize: '12px',
                  },
                }}
              >
                Tags
              </Button>
            }
          />
        </Box>

        <Stack
          className="file-browser-content-main"
          gap={{ xs: '16px', md: '24px' }}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            px: { xs: 2, md: 0 },
          }}
        >
          {/* Mobile Search and Filter Section */}
          <MobileSearchFilter
            searchValue={filter.search || ''}
            onSearchChange={value => handleFilterChange({ ...filter, search: value })}
            sortField={sortField}
            sortDirection={sortDirection}
            onSortChange={(field, direction) => {
              setSortField(field);
              setSortDirection(direction);
              setCurrentPage(1);
            }}
            fileFilterType={
              filter.filters?.shared === true ? 'shared' : filter.filters?.curated === true ? 'curated' : 'all'
            }
            onFileFilterChange={handleFileFilterChange}
            fileTypeValue={filter.filters?.type || 'all'}
            onFileTypeChange={type => {
              handleFilterChange({
                ...filter,
                filters: {
                  ...filter.filters,
                  type: type === 'all' ? undefined : (type as any),
                },
              });
            }}
            onUploadFiles={handleUploadFiles}
            onAddFromUrl={handleAddFromUrl}
            onCreateKnowledge={handleCreateKnowledge}
            onCreateDataLake={isAdminFeatureEnabled('EnableDataLakes') ? openDataLakeManager : undefined}
            isUploading={createFile.isPending}
          />

          {/* Mobile View Mode Toggle */}
          <Box sx={{ display: { xs: 'block', md: 'none' } }}>
            <FileBrowserViewActions
              value={viewAction}
              onChange={f => {
                setNavigatedFromTags(false);
                setViewActions(f);
              }}
            />
          </Box>

          <Stack
            className="file-browser-content-header-row"
            sx={{
              flexDirection: { xs: 'column', md: 'row' },
              gap: { xs: '12px', md: '20px' },
              alignItems: { xs: 'stretch', md: 'center' },
            }}
          >
            <Box
              className="file-browser-content-header"
              sx={{
                flex: { md: 1 },
              }}
            >
              <Typography
                className="file-browser-content-title"
                level="body-lg"
                sx={{
                  color: 'text.primary',
                  fontSize: { xs: '18px', md: '20px' },
                  fontWeight: '400',
                  lineHeight: '150%',
                  marginBottom: '2px',
                }}
              >
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  Total Files - {totalFiles}
                  <FieldTooltip
                    ariaLabel="Help: Files count"
                    content="This is the number of unique files you own. Workspace counts below show how many of your files belong to each tag namespace — a single file can appear in multiple workspaces if it has tags from different namespaces, so workspace totals may add up to more than this number."
                    placement="bottom-start"
                    iconSize={16}
                  />
                </Box>
              </Typography>
              <Typography
                className="file-browser-content-subtitle"
                level="body-xs"
                sx={{
                  color: 'fileBrowser.lightTextColor',
                  fontSize: { xs: '12px', md: '16px' },
                  fontWeight: '400',
                  lineHeight: '150%',
                }}
              >
                {filter.filters?.shared === true
                  ? 'Files that have been shared with you by other users'
                  : filter.filters?.curated === true
                    ? 'Curated notebooks generated from your AI conversations'
                    : 'Tap to select one or more files and add them to your notebook session'}
              </Typography>
            </Box>

            <Box
              className="file-browser-content-storage"
              sx={{
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                maxWidth: { xs: '100%', md: '430px' },
                flex: { xs: 0, md: 1 },
                height: { xs: 'auto', md: '32px' },
                mt: { xs: '0px', md: '8px' },
              }}
            >
              <FileStorageBar
                currentStorageInBytes={currentUser?.currentStorageSize ?? 0}
                storageLimitInBytes={(currentUser?.storageLimit ?? 1000) * 1000000}
              />
            </Box>
          </Stack>

          {/* Desktop Actions - Always visible */}
          <Stack
            className="file-browser-desktop-actions"
            direction={{ xs: 'column', sm: 'row' }}
            gap={{ xs: '8px', sm: '10px' }}
            sx={{
              display: { xs: 'none', md: 'flex' },
              flexWrap: { sm: 'wrap' },
            }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} gap={{ xs: '8px', sm: '10px' }} sx={{ flex: 1 }}>
              <FileBrowserViewActions
                value={viewAction}
                onChange={f => {
                  setNavigatedFromTags(false);
                  setViewActions(f);
                }}
              />
              <FileBrowserFilter value={filter} onChange={handleFilterChange} />

              {isResearchEngineFeatureEnabled && <ResearchEngineModal />}
            </Stack>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              gap={{ xs: '8px', sm: '10px' }}
              sx={{
                width: { xs: '100%', sm: 'auto' },
              }}
            >
              <UploadDropdown isLoading={isLoading} />
            </Stack>
          </Stack>

          {viewAction.viewMode === 'home' && (
            <HomeViewPanel
              selectedIds={selectedIds}
              recentFiles={recentFiles}
              isLoadingRecent={isLoadingRecent}
              recentTotal={recentData?.total}
              onNavigateToNamespace={namespace => {
                if (namespace) {
                  setTagViewInitialNamespace(namespace);
                } else {
                  setTagViewInitialNamespace(undefined);
                }
                setViewActions({ ...viewAction, viewMode: 'tags' });
              }}
              onFileSelect={fileId => {
                const newSet = new Set(selectedIds);
                if (newSet.has(fileId)) {
                  newSet.delete(fileId);
                } else {
                  newSet.add(fileId);
                }
                setSelectedIds(newSet);
              }}
            />
          )}

          {viewAction.viewMode === 'tags' && (
            <TagViewPanel
              key={tagViewInitialNamespace}
              initialNamespace={tagViewInitialNamespace}
              onFilterByTag={tagName => {
                setTagViewInitialNamespace(undefined);
                setNavigatedFromTags(true);
                setViewActions({ ...viewAction, viewMode: 'list' });
                handleFilterChange({
                  ...filter,
                  filters: { ...(filter.filters || {}), tags: [tagName] },
                });
              }}
            />
          )}

          {viewAction.viewMode !== 'tags' && viewAction.viewMode !== 'home' && !hasFilters && (
            <>
              <Stack sx={{ display: 'flex', flexDirection: 'column', height: '100%', mb: 2 }}>
                <FileBrowserList
                  files={allFiles}
                  fileTags={fileTags}
                  viewType={viewAction.viewMode as 'list' | 'grid'}
                  emptyDescription="You have no files"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSortChange={handleSortChange}
                  isLoading={isLoading}
                  isFetching={isFetching}
                  fileFilterType={
                    filter.filters?.shared === true ? 'shared' : filter.filters?.curated === true ? 'curated' : 'all'
                  }
                  onFileFilterChange={handleFileFilterChange}
                  onOpenTagManager={() => setIsTagSidebarOpen(!isTagSidebarOpen)}
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={setCurrentPage}
                />
              </Stack>
            </>
          )}

          {viewAction.viewMode !== 'tags' && viewAction.viewMode !== 'home' && hasFilters && (
            <Stack
              direction="column"
              gap={{ xs: '16px', md: '20px' }}
              sx={{ flex: 1, minHeight: 0, height: '100%', mb: 2 }}
            >
              {navigatedFromTags && (
                <Chip
                  data-testid="back-to-tags-chip"
                  variant="soft"
                  color="primary"
                  size="sm"
                  startDecorator={<ArrowBackIcon sx={{ fontSize: 16 }} />}
                  onClick={() => {
                    setNavigatedFromTags(false);
                    setViewActions({ ...viewAction, viewMode: 'tags' });
                    handleFilterChange({ ...filter, filters: { ...(filter.filters || {}), tags: [] } });
                  }}
                  sx={{ alignSelf: 'flex-start', cursor: 'pointer' }}
                >
                  Back to Tags
                </Chip>
              )}
              <Stack
                component="div"
                sx={{
                  flex: 1,
                  minHeight: 0,
                  overflow: 'hidden',
                  position: 'relative',
                  gap: { xs: '16px', md: '20px' },
                }}
              >
                <FileBrowserList
                  files={allFiles}
                  fileTags={fileTags}
                  viewType={viewAction.viewMode as 'list' | 'grid'}
                  emptyDescription="You have no files"
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSortChange={handleSortChange}
                  isLoading={isLoading}
                  isFetching={isFetching}
                  fileFilterType={
                    filter.filters?.shared === true ? 'shared' : filter.filters?.curated === true ? 'curated' : 'all'
                  }
                  onFileFilterChange={handleFileFilterChange}
                  onOpenTagManager={() => setIsTagSidebarOpen(!isTagSidebarOpen)}
                  availableTagOptions={availableOptions}
                  selectedTags={filter.filters?.tags || []}
                  onTagsChange={t => {
                    handleFilterChange({
                      ...filter,
                      filters: {
                        ...(filter.filters || {}),
                        tags: t,
                      },
                    });
                  }}
                  onClearAll={handleClearAllTags}
                  currentPage={currentPage}
                  totalPages={totalPages}
                  onPageChange={setCurrentPage}
                />
              </Stack>
            </Stack>
          )}
        </Stack>

        <Box
          className="file-browser-bottom-bar"
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: { xs: '0 16px', md: '0' },
            borderTop: '1px solid',
            borderTopColor: 'fileBrowser.bottomBar.borderTop',
            borderBottomLeftRadius: { xs: 0, md: '8px' },
            borderBottomRightRadius: { xs: 0, md: '8px' },
            maxHeight: { xs: 'auto', md: '60px' },
            minHeight: { xs: '56px', md: '60px' },
            flexShrink: 0,
          }}
        >
          {/* Selected Files Count Badge - Mobile Only */}
          {selectedIds.size > 0 && (
            <Box
              sx={{
                display: { xs: 'flex', md: 'none' },
                alignItems: 'center',
              }}
            >
              <Typography
                level="body-sm"
                sx={{
                  color: 'text.primary',
                  fontSize: '12px',
                  opacity: 0.75,
                }}
              >
                {selectedIds.size} file(s) {t('selected')}
              </Typography>
            </Box>
          )}

          <FileBrowserActions
            tags={fileTags || []}
            onTag={async tag => {
              await toggleTagToFiles({
                ids: Array.from(selectedIds),
                tags: [tag],
              });
            }}
            hasSelectedAll={selectedIds.size === selectableFiles.length}
            selectedCount={selectedIds.size}
            onSelectAll={handleSelectAll}
            onDelete={handleDelete}
            onAdd={handleAdd}
            onShare={handleBulkShare}
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={viewAction.viewMode === 'home' ? undefined : setCurrentPage}
            isLoadingPage={isFetching}
          />
        </Box>

        {/* Bulk Share Modal */}
        {showBulkShareModal && (
          <ShareDocumentModal
            files={selectedFiles}
            type={InviteType.FabFile}
            open={showBulkShareModal}
            onClose={() => {
              setShowBulkShareModal(false);
              setSelectedIds(new Set<string>());
            }}
          />
        )}

        {/* Individual File Share Modal */}
        {fileToShare && (
          <ShareDocumentModal
            onClose={() => setFileToShare(null)}
            open={true}
            id={fileToShare.id}
            name={fileToShare.fileName}
            type={InviteType.FabFile}
            users={fileToShare.users}
          />
        )}

        {/* Tag Creation Modal */}
        <Modal
          className="file-browser-tag-modal"
          open={showTagModal}
          onClose={isPendingCreateTag ? undefined : () => setShowTagModal(false)}
        >
          <ModalDialog
            className="file-browser-tag-modal-dialog"
            sx={{ width: '480px', maxHeight: '90vh', overflow: 'auto' }}
          >
            <Box
              style={{
                justifyContent: 'center',
                alignItems: 'center',
                display: 'flex',
                flexDirection: 'column',
                padding: '8px',
              }}
            >
              <ModalClose />

              <Typography
                className="file-browser-tag-modal-title"
                level="title-lg"
                sx={{
                  color: 'text.primary',
                  fontWeight: '400',
                  size: '20px',
                  lineHeight: '150%',
                  margin: '8px 0px 8px 0px',
                }}
              >
                Create a New Tag
              </Typography>

              <Typography
                className="file-browser-tag-modal-subtitle"
                level="body-sm"
                sx={{
                  color: 'fileBrowser.createTag.secondaryText',
                  fontWeight: '400',
                  size: '14px',
                  lineHeight: '130%',
                  mb: '8px',
                }}
              >
                Design a beautiful tag to organize your files effortlessly.
              </Typography>

              <TagForm
                onSubmit={tag => {
                  createTag(tag).then(() => {
                    setShowTagModal(false);
                  });
                }}
                submitting={isPendingCreateTag}
              />
            </Box>
          </ModalDialog>
        </Modal>
      </Box>

      {/* Tag Sidebar - Outside the main content area */}
      <TagSidebar
        tags={fileTags || []}
        isOpen={isTagSidebarOpen}
        onToggle={() => setIsTagSidebarOpen(!isTagSidebarOpen)}
        onTagClick={handleTagSidebarClick}
        onClearAllTags={handleClearAllTags}
        activeTags={filter.filters?.tags || []}
        onCreateTag={handleCreateTagFromSidebar}
        selectedFileIds={selectedIds}
        onAddTagToFiles={handleAddTagToFiles}
      />

      {/* URL Modal for mobile upload */}
      <CreateKnowledgeFromUrl openModal={openUrlModal} setOpenModal={setOpenUrlModal} modalOnly={true} />
    </>
  );
};

export const UploadDropdown: FC<{ isLoading: boolean }> = ({ isLoading }) => {
  const createFile = useCreateFabFile();
  const openDataLakeManager = useDataLakeWizardStore(s => s.openManager);
  // Hide the Data Lakes manager entry when the feature is off, matching the rest
  // of the data-lake surface (CreateDataLakeButton etc).
  const { isFeatureEnabled } = useAdminSettingsCache();
  const [openUrl, setOpenUrl] = useState(false);
  const [setKnowledgeOpen, setSelectedFabFileId, setViewOnly] = useKnowledgeModal(
    useShallow(state => [state.setOpen, state.setSelectedFabFileId, state.setViewOnly] as const)
  );

  const handleUploadFiles = (files: File[]) => {
    createFile.mutate(
      files.map(file => ({
        file,
        type: KnowledgeType.FILE,
        fileName: file.name,
        mimeType: file.type,
        fileSize: file.size,
      }))
    );
  };

  const handleAddFromUrl = () => {
    setOpenUrl(true);
  };

  const handleCreateKnowledge = () => {
    setSelectedFabFileId(null);
    setViewOnly(false);
    setKnowledgeOpen(true);
  };

  return (
    <>
      <UploadActionsSelect
        onUploadFiles={handleUploadFiles}
        onAddFromUrl={handleAddFromUrl}
        onCreateKnowledge={handleCreateKnowledge}
        onCreateDataLake={isFeatureEnabled('EnableDataLakes') ? openDataLakeManager : undefined}
        isUploading={createFile.isPending}
        variant="desktop"
      />
      <CreateKnowledgeFromUrl openModal={openUrl} setOpenModal={setOpenUrl} modalOnly={true} />
    </>
  );
};

export default FileBrowserContent;
