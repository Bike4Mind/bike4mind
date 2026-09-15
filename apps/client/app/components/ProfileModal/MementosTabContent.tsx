import { dayjs, IMementoDocument, MementoTier, MementoType } from '@bike4mind/common';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Input,
  LinearProgress,
  Modal,
  Card,
  ModalDialog,
  Sheet,
  Stack,
  Table,
  Textarea,
  Tooltip,
  Typography,
  Divider,
} from '@mui/joy';
import LocalFireDepartmentIcon from '@mui/icons-material/LocalFireDepartment';
import AcUnitIcon from '@mui/icons-material/AcUnit';
import WbTwilightIcon from '@mui/icons-material/WbTwilight';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import SearchIcon from '@mui/icons-material/Search';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import BoltIcon from '@mui/icons-material/Bolt';
import MemoryIcon from '@mui/icons-material/Memory';
// import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
// import LightbulbIcon from '@mui/icons-material/Lightbulb';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { keyframes } from '@mui/system';
import { useState, useMemo } from 'react';
import { useServerSettings } from '@client/app/contexts/UserSettingsContext';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createMementoOnServer,
  createBatchMementosOnServer,
  deleteAllMementosFromServer,
  deleteMementoFromServer,
  updateMementoOnServer,
} from '@client/app/utils/mementosAPICalls';
import { toast } from 'sonner';
import { AxiosError } from 'axios';
import { useSessions } from '@client/app/contexts/SessionsContext';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';
import MementosV2Panel from './MementosV2Panel';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { calculateMemoryUsage, calculateTierMemoryUsage, buildMementosCSV } from '@client/app/utils/mementoHelpers';
import { CreateMementoDTO, UpdateMementoDTO } from '@client/app/utils/mementoDtos';
import { useGetMementos } from '@client/app/hooks/data/mementos';
import { ContextHelpButton } from '@client/app/components/help';

const DEFAULT_MAX_TOTAL_CHARS = 32000; // Fallback value if setting is not found

const WARNING_THRESHOLD = 0.75;
const DANGER_THRESHOLD = 0.9;

const pulseAnimation = keyframes`
  0% {
    opacity: 0.6;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0.6;
  }
`;

const getTierIcon = (tier: MementoTier) => {
  switch (tier) {
    case MementoTier.HOT:
      return <LocalFireDepartmentIcon color="error" />;
    case MementoTier.WARM:
      return <WbTwilightIcon color="warning" />;
    case MementoTier.COLD:
      return <AcUnitIcon color="primary" />;
  }
};

interface EditableMementoState {
  [key: string]: {
    weight?: number;
    summary?: string;
    tags?: string[];
    newTag?: string;
    isDirty: boolean;
    tier?: MementoTier;
  };
}

const truncateText = (text: string, maxLength: number = 100) => {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '...';
};

const ITEMS_PER_PAGE = 10;

type SortField = 'tier' | 'type' | 'weight' | 'summary' | 'lastAccessedAt' | 'tags' | 'updatedAt';
type SortOrder = 'asc' | 'desc';

interface DraftMemento {
  type: MementoType;
  tier: MementoTier;
  weight: number;
  summary: string;
  fullContent: string;
  tags: string[];
}

// Module-level component for sortable table headers
const SortableHeader = ({
  field,
  width,
  children,
  onSort,
  currentSortField,
  currentSortOrder,
}: {
  field: SortField;
  width: string;
  children: React.ReactNode;
  onSort: (field: SortField) => void;
  currentSortField: SortField;
  currentSortOrder: 'asc' | 'desc';
}) => (
  <th style={{ width, cursor: 'pointer' }} onClick={() => onSort(field)}>
    <Stack className="mementos-tab-sort-header" direction="row" spacing={1} alignItems="center">
      {children}
      {currentSortField === field &&
        (currentSortOrder === 'asc' ? (
          <ArrowUpwardIcon className="mementos-tab-sort-icon" sx={{ fontSize: 16 }} />
        ) : (
          <ArrowDownwardIcon className="mementos-tab-sort-icon" sx={{ fontSize: 16 }} />
        ))}
    </Stack>
  </th>
);

// Module-level component for pagination controls
const MementosPaginationControls = ({
  currentPage,
  totalPages,
  onPageChange,
  totalCount,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalCount: number;
}) => (
  <Stack
    className="mementos-tab-pagination"
    direction="row"
    justifyContent="space-between"
    alignItems="center"
    sx={{ mt: 2, width: '100%' }}
  >
    <Stack direction="row" spacing={2} justifyContent="center" alignItems="center">
      <Button
        className="mementos-tab-pagination-button"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        Previous
      </Button>
      <Typography className="mementos-tab-pagination-text">
        Page {currentPage} of {totalPages}
      </Typography>
      <Button
        className="mementos-tab-pagination-button"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </Button>
    </Stack>

    <Stack direction="row" spacing={2} justifyContent="center" alignItems="center" pr={'0.5em'}>
      <Typography className="mementos-tab-total-count" level="body-sm" fontWeight={800}>
        Total Mementos: {totalCount}
      </Typography>
    </Stack>
  </Stack>
);

const MementosTabContentInner = () => {
  const { serverSettings } = useServerSettings();
  const maxTotalChars =
    Number(serverSettings.find(s => s.settingName === 'MementoMaxTotalChars')?.settingValue) || DEFAULT_MAX_TOTAL_CHARS;
  const [page, setPage] = useState(1);
  const [editableState, setEditableState] = useState<EditableMementoState>({});
  const [deleteConfirmation, setDeleteConfirmation] = useState<{
    open: boolean;
    mementoId?: string;
    isDeleteAll?: boolean;
  }>({ open: false });
  const { currentSessionId } = useSessions();
  const [sortField, setSortField] = useState<SortField>('lastAccessedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [searchTerm, setSearchTerm] = useState('');
  const [viewMode] = useState<'advanced' | 'regular'>('regular');
  const [draftMemento, setDraftMemento] = useState<DraftMemento>({
    type: MementoType.INSIGHT,
    tier: MementoTier.HOT,
    weight: 999,
    summary: '',
    fullContent: '',
    tags: [],
  });
  const [draftTag, setDraftTag] = useState('');
  const { data: mementos = [], isLoading } = useGetMementos();
  const queryClient = useQueryClient();

  const deleteMementoMutation = useMutation({
    mutationFn: async (mementoId: string) => {
      await deleteMementoFromServer(mementoId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mementos'] });
      toast.success('Memento deleted successfully');
    },
  });
  const deleteAllMementosMutation = useMutation({
    mutationFn: async () => {
      await deleteAllMementosFromServer();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mementos'] });
      toast.success('All mementos deleted successfully');
    },
    onError: (err: AxiosError<{ error: string }>) => {
      console.log(err);
      toast.error(`Failed to delete all mementos: ${err.response?.data?.error || err.message}`);
    },
  });
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const importMementosMutation = useMutation({
    mutationFn: async (text: string) => {
      const sessionId = currentSessionId ?? null;
      const lines = text.split('\n').filter(line => line.trim());
      const mementos: CreateMementoDTO[] = lines.map(line => ({
        type: MementoType.INSIGHT,
        tier: MementoTier.HOT,
        weight: 500,
        summary: line.trim(),
        fullContent: line.trim(),
        sessionId: sessionId,
        lastAccessedAt: new Date(),
        isArchived: false,
        tags: ['imported', 'openai'],
      }));
      return createBatchMementosOnServer(mementos);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mementos'] });
      toast.success('Memories imported successfully');
      setImportModalOpen(false);
      setImportText('');
      setIsImporting(false);
    },
    onError: (err: AxiosError<{ error: string }>) => {
      console.error(err);
      toast.error(`Failed to import memories: ${err.response?.data?.error || err.message}`);
      setIsImporting(false);
    },
  });

  const handleImport = async () => {
    if (!importText.trim()) {
      toast.error('Please enter some memories to import');
      return;
    }
    setIsImporting(true);
    importMementosMutation.mutate(importText);
  };

  const filteredMementos = useMemo(() => {
    return mementos.filter(memento => {
      if (viewMode === 'regular' && memento.tier !== MementoTier.HOT) {
        return false;
      }

      const searchLower = searchTerm.toLowerCase();
      // Split search terms by spaces to allow searching for multiple terms
      const searchTerms = searchLower.split(/\s+/).filter(term => term.length > 0);

      if (searchTerms.length === 0) return true;

      return searchTerms.every(term => {
        return (
          memento.summary.toLowerCase().includes(term) ||
          memento.type.toLowerCase().includes(term) ||
          memento.tier.toLowerCase().includes(term) ||
          (memento.tags && memento.tags.some(tag => tag.toLowerCase().includes(term))) ||
          memento.fullContent.toLowerCase().includes(term)
        );
      });
    });
  }, [mementos, viewMode, searchTerm]);

  const handleDeleteClick = (mementoId: string) => {
    setDeleteConfirmation({ open: true, mementoId });
  };

  const handleDeleteAllClick = () => {
    setDeleteConfirmation({ open: true, isDeleteAll: true });
  };

  const handleConfirmDelete = async () => {
    if (deleteConfirmation.isDeleteAll) {
      deleteAllMementosMutation.mutate();
    } else if (deleteConfirmation.mementoId) {
      deleteMementoMutation.mutate(deleteConfirmation.mementoId);
    }
    setDeleteConfirmation({ open: false });
  };

  const handleWeightChange = (mementoId: string, value: string) => {
    const numValue = Math.min(1000, Math.max(0, Number(value) || 0));
    setEditableState(prev => ({
      ...prev,
      [mementoId]: {
        ...prev[mementoId],
        weight: numValue,
        isDirty: true,
      },
    }));
  };

  const handleSummaryChange = (mementoId: string, value: string) => {
    setEditableState(prev => ({
      ...prev,
      [mementoId]: {
        ...prev[mementoId],
        summary: value,
        isDirty: true,
      },
    }));
  };

  const handleTierChange = (mementoId: string, newTier: MementoTier) => {
    const memento = mementos.find(m => m.id === mementoId);
    if (!memento || memento.tier === newTier) return;

    setEditableState(prev => ({
      ...prev,
      [mementoId]: {
        ...prev[mementoId],
        tier: newTier,
        isDirty: true,
      },
    }));
  };

  const updateMementoMutation = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: UpdateMementoDTO }) => {
      await updateMementoOnServer(id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mementos'] });
      toast.success('Memento updated successfully');
    },
    onError: (err: AxiosError<{ error: string }>) => {
      console.error(err);
      toast.error(`Failed to update memento: ${err.response?.data?.error || err.message}`);
    },
  });

  const handleSave = (mementoId: string, memento: IMementoDocument) => {
    const updates = editableState[mementoId];
    if (!updates?.isDirty) return;

    const updateData: UpdateMementoDTO = {};

    if (updates.weight !== undefined) updateData.weight = updates.weight;
    if (updates.summary !== undefined) updateData.summary = updates.summary;
    if (updates.tier !== undefined) updateData.tier = updates.tier;
    if (updates.tags !== undefined) updateData.tags = updates.tags;

    console.log('Saving memento:', mementoId, updateData);

    updateMementoMutation.mutate({
      id: mementoId,
      updates: updateData,
    });

    // Clear dirty state after save attempt
    setEditableState(prev => ({
      ...prev,
      [mementoId]: {
        ...prev[mementoId],
        isDirty: false,
      },
    }));
  };

  const getConfirmationMessage = () => {
    if (deleteConfirmation.isDeleteAll) {
      return `Are you sure you want to delete all ${mementos.length} mementos? This action cannot be undone.`;
    }

    const targetMemento = mementos.find(m => m.id === deleteConfirmation.mementoId);
    return targetMemento ? (
      <>
        Are you sure you want to delete this memento?
        <Typography className="mementos-tab-delete-confirm-text" level="h4" sx={{ mt: 1, mb: 1, fontStyle: 'italic' }}>
          &quot;{truncateText(targetMemento.summary)}&quot;
        </Typography>
        This action cannot be undone.
      </>
    ) : (
      'Are you sure you want to delete this memento? This action cannot be undone.'
    );
  };

  const handleTagDelete = (mementoId: string | undefined, tagToDelete: string) => {
    if (!mementoId) return;

    // Handle draft memento tag deletion
    if (mementoId === 'draft') {
      setDraftMemento(prev => ({
        ...prev,
        tags: prev.tags.filter(tag => tag !== tagToDelete),
      }));
      return;
    }

    // Handle existing memento tag deletion
    const memento = mementos.find(m => m.id === mementoId);
    if (!memento) return;

    const currentTags = editableState[mementoId]?.tags ?? memento.tags ?? [];

    setEditableState(prev => ({
      ...prev,
      [mementoId]: {
        ...prev[mementoId],
        tags: currentTags.filter(tag => tag !== tagToDelete),
        isDirty: true,
      },
    }));
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(current => (current === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedMementos = useMemo(() => {
    return [...filteredMementos].sort((a, b) => {
      const multiplier = sortOrder === 'asc' ? 1 : -1;

      switch (sortField) {
        case 'tier':
          return multiplier * a.tier.localeCompare(b.tier);
        case 'type':
          return multiplier * a.type.localeCompare(b.type);
        case 'weight':
          return multiplier * (a.weight - b.weight);
        case 'summary':
          return multiplier * a.summary.localeCompare(b.summary);
        case 'lastAccessedAt':
          return multiplier * (new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime());
        case 'tags':
          return multiplier * (a.tags?.join(',') ?? '').localeCompare(b.tags?.join(',') ?? '');
        case 'updatedAt':
          return multiplier * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        default:
          return 0;
      }
    });
  }, [filteredMementos, sortField, sortOrder]);

  // const handleViewModeChange = (newViewMode: 'regular' | 'advanced') => {
  //   setViewMode(newViewMode);
  //   setPage(1); // Reset to first page when changing view mode
  // };

  const paginatedMementos = useMemo(
    () => sortedMementos.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE),
    [sortedMementos, page]
  );

  const totalPages = Math.ceil(filteredMementos.length / ITEMS_PER_PAGE);

  const renderTagsCell = (memento: IMementoDocument) => {
    const mementoId = memento.id;
    const currentTags = editableState[mementoId]?.tags ?? memento.tags ?? [];
    const newTag = editableState[mementoId]?.newTag ?? '';

    const handleAddExistingTag = () => {
      if (!newTag.trim()) return;

      const updatedTags = [...currentTags, newTag.trim()];
      setEditableState(prev => ({
        ...prev,
        [mementoId]: {
          ...prev[mementoId],
          tags: updatedTags,
          newTag: '',
          isDirty: true,
        },
      }));
    };

    return (
      <Stack className="mementos-tab-tags-container" direction="row" spacing={1} flexWrap="wrap" alignItems="center">
        {currentTags.map((tag, tagIndex) => (
          <Chip
            className="mementos-tab-tag-chip"
            key={tagIndex}
            size="sm"
            variant="outlined"
            endDecorator={<CloseIcon sx={{ fontSize: '0.7rem' }} />}
            onClick={e => {
              e.preventDefault();
              e.stopPropagation();
              handleTagDelete(mementoId, tag);
            }}
            sx={{ cursor: 'pointer' }}
          >
            {tag}
          </Chip>
        ))}
        <Box className="mementos-tab-view-mode-toggle" sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
          <Input
            className="mementos-tab-tag-input"
            size="sm"
            placeholder="Add tag"
            value={newTag}
            onChange={e =>
              setEditableState(prev => ({
                ...prev,
                [mementoId]: {
                  ...prev[mementoId],
                  newTag: e.target.value,
                },
              }))
            }
            onKeyDown={e => {
              if (e.key === 'Enter') {
                handleAddExistingTag();
              }
            }}
            sx={{ width: '100px' }}
          />
          <IconButton
            className="mementos-tab-tag-add-button"
            size="sm"
            variant="plain"
            color="neutral"
            onClick={handleAddExistingTag}
          >
            <AddIcon />
          </IconButton>
        </Box>
      </Stack>
    );
  };

  const createMementoMutation = useMutation({
    mutationFn: createMementoOnServer,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mementos'] });
      toast.success('Memento created successfully');
      setDraftMemento({
        type: MementoType.INSIGHT,
        tier: MementoTier.HOT,
        weight: 999,
        summary: '',
        fullContent: '',
        tags: [],
      });
    },
    onError: (err: AxiosError<{ error: string }>) => {
      console.error(err);
      toast.error(`Failed to create memento: ${err.response?.data?.error || err.message}`);
    },
  });

  const handleCreateMemento = async () => {
    try {
      createMementoMutation.mutate({
        ...draftMemento,
        fullContent: draftMemento.fullContent || draftMemento.summary,
        sessionId: currentSessionId ?? null,
        lastAccessedAt: new Date(),
        isArchived: false,
      });
    } catch (error) {
      console.error('Error creating memento:', error);
      toast.error('Failed to create memento: Could not create session');
    }
  };

  const handleExportCSV = () => {
    const csvContent = buildMementosCSV(mementos);

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `mementos_export_${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const memoryUsage = useMemo(() => calculateMemoryUsage(mementos), [mementos]);
  const hotMemoryUsage = useMemo(() => calculateTierMemoryUsage(mementos, MementoTier.HOT), [mementos]);
  const warmMemoryUsage = useMemo(() => calculateTierMemoryUsage(mementos, MementoTier.WARM), [mementos]);
  const coldMemoryUsage = useMemo(() => calculateTierMemoryUsage(mementos, MementoTier.COLD), [mementos]);

  const hotUsagePercent = (hotMemoryUsage / maxTotalChars) * 100;
  const memoryColor =
    hotUsagePercent >= DANGER_THRESHOLD * 100
      ? 'danger'
      : hotUsagePercent >= WARNING_THRESHOLD * 100
        ? 'warning'
        : 'success';

  const getMemoryStatusIcon = () => {
    if (hotUsagePercent >= DANGER_THRESHOLD * 100) {
      return <BoltIcon sx={{ color: 'danger.500', animation: `${pulseAnimation} 2s ease-in-out infinite` }} />;
    }
    return <MemoryIcon sx={{ color: memoryColor + '.500' }} />;
  };

  if (isLoading) {
    return (
      <Box
        className="mementos-tab-content-loading"
        sx={{ width: '100%', display: 'flex', justifyContent: 'center', alignItems: 'center', py: 4 }}
      >
        <LinearProgress />
      </Box>
    );
  }

  return (
    <Box className="mementos-tab-content-container" sx={{ width: '100%' }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, gap: 2 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography className="mementos-tab-content-title" level="h4" component="h2">
            Mementos
          </Typography>
          <ContextHelpButton helpId="features/mementos" tooltipText="Learn about Mementos" />
        </Stack>
        <Box className="mementos-tab-content-header-actions" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {/* <Box
            sx={{
              display: 'flex',
              borderRadius: 'md',
              bgcolor: 'background.level1',
              p: 0.5,
              gap: 0.5,
            }}
          >
            <Button
              size="sm"
              variant={viewMode === 'regular' ? 'solid' : 'plain'}
              color={viewMode === 'regular' ? 'primary' : 'neutral'}
              onClick={() => handleViewModeChange('regular')}
              startDecorator={<LightbulbIcon />}
              sx={{
                minWidth: '100px',
                transition: 'all 0.2s',
                ...(viewMode === 'regular' && {
                  '& svg': {
                    animation: `${pulseAnimation} 2s ease-in-out infinite`,
                  },
                }),
              }}
            >
              Regular
            </Button>
            <Button
              size="sm"
              variant={viewMode === 'advanced' ? 'solid' : 'plain'}
              color={viewMode === 'advanced' ? 'primary' : 'neutral'}
              onClick={() => handleViewModeChange('advanced')}
              startDecorator={<AutoFixHighIcon />}
              sx={{
                minWidth: '100px',
                transition: 'all 0.2s',
                ...(viewMode === 'advanced' && {
                  '& svg': {
                    animation: `${pulseAnimation} 2s ease-in-out infinite`,
                  },
                }),
              }}
            >
              Advanced
            </Button>
          </Box> */}
          <Input
            size="sm"
            placeholder="Search mementos..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            startDecorator={<SearchIcon />}
            sx={{ width: '300px' }}
          />
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Tooltip
              title={
                <Box sx={{ p: 1 }}>
                  <Typography level="body-sm" fontWeight="bold" mb={1}>
                    Memory Usage Breakdown:
                  </Typography>
                  <Stack spacing={1} sx={{ minWidth: '250px' }}>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <LocalFireDepartmentIcon color="error" fontSize="small" />
                        <Typography level="body-sm" fontWeight="bold">
                          HOT Tier: {Math.round(hotUsagePercent)}% ({hotMemoryUsage.toLocaleString()} chars)
                        </Typography>
                      </Stack>
                      <LinearProgress
                        determinate
                        value={Math.min(hotUsagePercent, 100)}
                        color={memoryColor}
                        variant="soft"
                        sx={{ height: 4, mt: 0.5, borderRadius: 'sm' }}
                      />
                    </Box>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <WbTwilightIcon color="warning" fontSize="small" />
                        <Typography level="body-sm">WARM Tier: {warmMemoryUsage.toLocaleString()} chars</Typography>
                      </Stack>
                    </Box>
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <AcUnitIcon color="primary" fontSize="small" />
                        <Typography level="body-sm">COLD Tier: {coldMemoryUsage.toLocaleString()} chars</Typography>
                      </Stack>
                    </Box>
                    <Divider />
                    <Typography level="body-xs" fontWeight="lg">
                      Total chars: {memoryUsage.toLocaleString()} / {maxTotalChars.toLocaleString()}
                    </Typography>
                    <Typography level="body-xs">
                      (HOT tier target: {Math.round(maxTotalChars * 0.8).toLocaleString()} chars)
                    </Typography>
                  </Stack>
                </Box>
              }
              variant="soft"
              placement="bottom-start"
            >
              <Box
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  px: 0.5,
                  borderRadius: 'lg',
                  border: '1px solid',
                  borderColor: theme => theme.vars.palette[memoryColor].outlinedBorder,
                  transition: 'all 0.2s ease-in-out',
                  cursor: 'help',
                  minWidth: '200px',
                  '&:hover': {
                    transform: 'translateY(-1px)',
                    boxShadow: 'sm',
                  },
                }}
              >
                <Stack direction="row" spacing={2} alignItems="center">
                  {getMemoryStatusIcon()}
                  <Typography
                    level="body-sm"
                    sx={{
                      fontWeight: 600,
                      color: theme => theme.vars.palette.text.primary,
                      transition: 'color 0.2s ease-in-out',
                    }}
                  >
                    HOT Memory: {Math.round(hotUsagePercent)}%
                  </Typography>
                </Stack>
                <LinearProgress
                  determinate
                  value={Math.min(hotUsagePercent, 100)}
                  color={memoryColor}
                  variant="soft"
                  sx={{
                    height: 6,
                    borderRadius: 'lg',
                    transition: 'all 0.2s ease-in-out',
                    '& .MuiLinearProgress-bar': {
                      transition: 'transform 0.4s ease-in-out, background-color 0.2s ease-in-out',
                      backgroundImage: theme =>
                        hotUsagePercent >= DANGER_THRESHOLD * 100
                          ? `linear-gradient(45deg, ${theme.vars.palette.danger.solidBg} 25%, ${theme.vars.palette.danger.solidHoverBg} 25%, ${theme.vars.palette.danger.solidHoverBg} 50%, ${theme.vars.palette.danger.solidBg} 50%, ${theme.vars.palette.danger.solidBg} 75%, ${theme.vars.palette.danger.solidHoverBg} 75%, ${theme.vars.palette.danger.solidHoverBg})`
                          : undefined,
                      backgroundSize: '40px 40px',
                      animation:
                        hotUsagePercent >= DANGER_THRESHOLD * 100 ? 'progress-bar-stripes 1s linear infinite' : 'none',
                    },
                    '@keyframes progress-bar-stripes': {
                      '0%': {
                        backgroundPosition: '40px 0',
                      },
                      '100%': {
                        backgroundPosition: '0 0',
                      },
                    },
                  }}
                />
              </Box>
            </Tooltip>
            <Stack direction="row" spacing={1}>
              {/* <Button
                variant="soft"
                color="primary"
                startDecorator={<MemoryIcon />}
                onClick={async () => {
                  try {
                    toast.loading('Optimizing memory...', { id: 'memory-optimization' });
                    await triggerMementoGrooming();
                    toast.success('Memory optimization scheduled', { id: 'memory-optimization' });
                    // Wait a moment and then refresh the mementos
                    setTimeout(() => {
                      queryClient.invalidateQueries({ queryKey: ['mementos'] });
                    }, 2000);
                  } catch (error) {
                    console.error('Memory optimization error:', error);
                    toast.error('Failed to optimize memory. Please try again later.', { id: 'memory-optimization' });
                  }
                }}
                size="sm"
              >
                Optimize Memory
              </Button> */}
              <Button
                variant="soft"
                color="primary"
                startDecorator={<FileDownloadIcon />}
                onClick={handleExportCSV}
                size="sm"
              >
                Export CSV
              </Button>
              <Button
                variant="soft"
                color="danger"
                startDecorator={deleteAllMementosMutation.isPending ? <CircularProgress size="sm" /> : <DeleteIcon />}
                onClick={handleDeleteAllClick}
                size="sm"
                disabled={deleteAllMementosMutation.isPending}
              >
                Delete All
              </Button>
            </Stack>
          </Box>
          <Button
            variant="soft"
            color="primary"
            startDecorator={<UploadFileIcon />}
            onClick={() => setImportModalOpen(true)}
            size="sm"
          >
            Import Memories
          </Button>
        </Box>
      </Box>

      <Sheet variant="outlined" sx={{ width: '100%', borderRadius: 'sm' }}>
        <Table aria-label="Mementos table" stickyHeader>
          <thead>
            <tr>
              {viewMode === 'advanced' && (
                <>
                  <SortableHeader
                    field="tier"
                    width="5%"
                    onSort={handleSort}
                    currentSortField={sortField}
                    currentSortOrder={sortOrder}
                  >
                    Tier
                  </SortableHeader>
                  <SortableHeader
                    field="type"
                    width="10%"
                    onSort={handleSort}
                    currentSortField={sortField}
                    currentSortOrder={sortOrder}
                  >
                    Type
                  </SortableHeader>
                  <SortableHeader
                    field="weight"
                    width="8%"
                    onSort={handleSort}
                    currentSortField={sortField}
                    currentSortOrder={sortOrder}
                  >
                    Weight
                  </SortableHeader>
                </>
              )}
              <SortableHeader
                field="summary"
                width={viewMode === 'advanced' ? '25%' : '50%'}
                onSort={handleSort}
                currentSortField={sortField}
                currentSortOrder={sortOrder}
              >
                Summary
              </SortableHeader>
              {viewMode === 'advanced' && (
                <SortableHeader
                  field="lastAccessedAt"
                  width="12%"
                  onSort={handleSort}
                  currentSortField={sortField}
                  currentSortOrder={sortOrder}
                >
                  <Typography level="body-sm">Last</Typography>
                </SortableHeader>
              )}
              <SortableHeader
                field="tags"
                width={viewMode === 'advanced' ? '30%' : '40%'}
                onSort={handleSort}
                currentSortField={sortField}
                currentSortOrder={sortOrder}
              >
                Tags
              </SortableHeader>
              <SortableHeader
                field="updatedAt"
                width="10%"
                onSort={handleSort}
                currentSortField={sortField}
                currentSortOrder={sortOrder}
              >
                Last Updated
              </SortableHeader>

              <th style={{ width: '10%' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {viewMode === 'advanced' && (
              <tr>
                <td>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      borderRadius: 'sm',
                      p: 0.5,
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      '&:hover': {
                        bgcolor: 'background.level1',
                        transform: 'translateY(-1px)',
                        boxShadow: 'sm',
                      },
                    }}
                  >
                    {getTierIcon(draftMemento.tier)}
                    <Typography
                      level="body-xs"
                      sx={{
                        ml: 0.5,
                        fontWeight: 500,
                      }}
                    >
                      {draftMemento.tier}
                    </Typography>
                    <select
                      value={draftMemento.tier}
                      onChange={e => setDraftMemento(prev => ({ ...prev, tier: e.target.value as MementoTier }))}
                      style={{
                        position: 'absolute',
                        inset: 0,
                        opacity: 0,
                        cursor: 'pointer',
                        width: '100%',
                        height: '100%',
                      }}
                      aria-label="Change memento tier"
                    >
                      {Object.values(MementoTier).map(tier => (
                        <option key={tier} value={tier}>
                          {tier}
                        </option>
                      ))}
                    </select>
                  </Box>
                </td>
                <td>
                  <Box sx={{ position: 'relative' }}>
                    <Chip
                      variant="soft"
                      color={
                        draftMemento.type === MementoType.INSIGHT
                          ? 'success'
                          : draftMemento.type === MementoType.PROMPT
                            ? 'primary'
                            : draftMemento.type === MementoType.REPLY
                              ? 'warning'
                              : 'neutral'
                      }
                    >
                      {draftMemento.type}
                    </Chip>
                    <select
                      value={draftMemento.type}
                      onChange={e => setDraftMemento(prev => ({ ...prev, type: e.target.value as MementoType }))}
                      style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
                    >
                      {Object.values(MementoType).map(type => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </select>
                  </Box>
                </td>
                <td>
                  <Input
                    size="sm"
                    type="number"
                    value={draftMemento.weight}
                    onChange={e =>
                      setDraftMemento(prev => ({
                        ...prev,
                        weight: Math.min(1000, Math.max(0, Number(e.target.value) || 0)),
                      }))
                    }
                    slotProps={{
                      input: {
                        min: 0,
                        max: 1000,
                      },
                    }}
                    sx={{ width: '80px' }}
                  />
                </td>
                <td>
                  <Input
                    size="sm"
                    placeholder="Summary..."
                    value={draftMemento.summary}
                    onChange={e => setDraftMemento(prev => ({ ...prev, summary: e.target.value }))}
                    sx={{ width: '100%' }}
                  />
                </td>
                <td>
                  <Typography level="body-sm">Now</Typography>
                </td>
                <td>
                  <Stack direction="row" spacing={1} flexWrap="wrap" alignItems="center">
                    {draftMemento.tags.map((tag, tagIndex) => (
                      <Chip
                        key={tagIndex}
                        size="sm"
                        variant="outlined"
                        endDecorator={<CloseIcon sx={{ fontSize: '0.7rem' }} />}
                        onClick={e => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleTagDelete('draft', tag);
                        }}
                        sx={{ cursor: 'pointer' }}
                      >
                        {tag}
                      </Chip>
                    ))}
                    <Box
                      className="mementos-tab-content-tag-input-container"
                      sx={{ display: 'flex', gap: 1, alignItems: 'center' }}
                    >
                      <Input
                        size="sm"
                        placeholder="Add tag"
                        value={draftTag}
                        onChange={e => setDraftTag(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' && draftTag.trim()) {
                            setDraftMemento(prev => ({
                              ...prev,
                              tags: [...prev.tags, draftTag.trim()],
                            }));
                            setDraftTag('');
                          }
                        }}
                        sx={{ width: '100px' }}
                      />
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => {
                          if (draftTag.trim()) {
                            setDraftMemento(prev => ({
                              ...prev,
                              tags: [...prev.tags, draftTag.trim()],
                            }));
                            setDraftTag('');
                          }
                        }}
                      >
                        <AddIcon />
                      </IconButton>
                    </Box>
                  </Stack>
                </td>
                <td>
                  <IconButton
                    variant="plain"
                    color="success"
                    size="sm"
                    onClick={handleCreateMemento}
                    disabled={!draftMemento.summary.trim()}
                  >
                    <AddIcon />
                  </IconButton>
                </td>
              </tr>
            )}
            {paginatedMementos.map((memento, index) => {
              const mementoId = memento.id;
              const isEdited = editableState[mementoId]?.isDirty;

              return (
                <tr key={index}>
                  {viewMode === 'advanced' && (
                    <>
                      <td>
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            position: 'relative',
                            borderRadius: 'sm',
                            p: 0.5,
                            cursor: 'pointer',
                            transition: 'all 0.2s',
                            '&:hover': {
                              bgcolor: 'background.level1',
                              transform: 'translateY(-1px)',
                              boxShadow: 'sm',
                            },
                          }}
                        >
                          {getTierIcon(editableState[mementoId]?.tier ?? memento.tier)}
                          <Typography
                            level="body-xs"
                            sx={{
                              ml: 0.5,
                              fontWeight: 500,
                            }}
                          >
                            {editableState[mementoId]?.tier ?? memento.tier}
                          </Typography>
                          <select
                            value={editableState[mementoId]?.tier ?? memento.tier}
                            onChange={e => handleTierChange(mementoId, e.target.value as MementoTier)}
                            style={{
                              position: 'absolute',
                              inset: 0,
                              opacity: 0,
                              cursor: 'pointer',
                              width: '100%',
                              height: '100%',
                            }}
                            aria-label="Change memento tier"
                          >
                            {Object.values(MementoTier).map(tier => (
                              <option key={tier} value={tier}>
                                {tier}
                              </option>
                            ))}
                          </select>
                        </Box>
                      </td>
                      <td>
                        <Chip
                          variant="soft"
                          color={
                            memento.type === MementoType.INSIGHT
                              ? 'success'
                              : memento.type === MementoType.PROMPT
                                ? 'primary'
                                : memento.type === MementoType.REPLY
                                  ? 'warning'
                                  : 'neutral'
                          }
                        >
                          {memento.type}
                        </Chip>
                      </td>
                      <td>
                        <Input
                          size="sm"
                          type="number"
                          value={editableState[mementoId]?.weight ?? memento.weight}
                          onChange={e => handleWeightChange(mementoId, e.target.value)}
                          slotProps={{
                            input: {
                              min: 0,
                              max: 1000,
                            },
                          }}
                          sx={{ width: '80px' }}
                        />
                      </td>
                    </>
                  )}
                  <td>
                    <Tooltip
                      title={memento.fullContent}
                      variant="soft"
                      placement="top-start"
                      sx={{ maxWidth: '500px' }}
                    >
                      <Input
                        size="sm"
                        value={editableState[mementoId]?.summary ?? memento.summary}
                        onChange={e => handleSummaryChange(mementoId, e.target.value)}
                        sx={{ width: '100%' }}
                      />
                    </Tooltip>
                  </td>
                  {viewMode === 'advanced' && <td>{new Date(memento.lastAccessedAt).toLocaleDateString()}</td>}
                  <td>{renderTagsCell(memento)}</td>
                  <td>
                    <Tooltip title={dayjs(memento.updatedAt).format('llll')}>
                      <Typography level="body-xs">{dayjs(memento.updatedAt).fromNow()}</Typography>
                    </Tooltip>
                  </td>
                  <td>
                    <Stack direction="row" spacing={1}>
                      {isEdited && (
                        <IconButton
                          variant="plain"
                          color="primary"
                          size="sm"
                          onClick={() => handleSave(mementoId, memento)}
                        >
                          <SaveIcon />
                        </IconButton>
                      )}
                      <IconButton variant="plain" color="danger" size="sm" onClick={() => handleDeleteClick(mementoId)}>
                        {deleteMementoMutation.isPending && deleteMementoMutation.variables === mementoId ? (
                          <CircularProgress size="sm" />
                        ) : (
                          <DeleteIcon />
                        )}
                      </IconButton>
                    </Stack>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </Sheet>

      <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2, width: '100%' }}>
        <MementosPaginationControls
          currentPage={page}
          totalPages={totalPages}
          onPageChange={setPage}
          totalCount={filteredMementos.length}
        />
      </Box>

      <Modal open={deleteConfirmation.open} onClose={() => setDeleteConfirmation({ open: false })}>
        <ModalDialog
          variant="outlined"
          role="alertdialog"
          aria-labelledby="delete-confirmation-title"
          aria-describedby="delete-confirmation-description"
        >
          <Typography id="delete-confirmation-title" level="h2" fontSize="lg" startDecorator={<DeleteIcon />}>
            Confirmation
          </Typography>
          <Typography id="delete-confirmation-description" level="h4">
            {getConfirmationMessage()}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={() => setDeleteConfirmation({ open: false })}>
              Cancel
            </Button>
            <Button variant="solid" color="danger" onClick={handleConfirmDelete}>
              Delete
            </Button>
          </Box>
        </ModalDialog>
      </Modal>

      <Modal open={importModalOpen} onClose={() => !isImporting && setImportModalOpen(false)}>
        <ModalDialog
          variant="outlined"
          role="alertdialog"
          aria-labelledby="import-modal-title"
          aria-describedby="import-modal-description"
          sx={{ maxWidth: 600 }}
        >
          <Typography id="import-modal-title" component="h2" level="h4" startDecorator={<UploadFileIcon />}>
            Import Memories
          </Typography>
          <Typography id="import-modal-description" level="body-md">
            Paste your memories from OpenAI, one per line. Each line will be imported as a separate memory.
            <br />
            <br />
            <Card variant="outlined" sx={{ p: 2 }}>
              <Typography level="body-sm">
                Hint: ChatGPT | Settings | Personalization | Memory | Manage - and then highlight all and copy Ctrl-C
                and then paste here.
              </Typography>
            </Card>
          </Typography>
          <Textarea
            minRows={10}
            maxRows={20}
            placeholder="Paste your memories here..."
            value={importText}
            onChange={e => setImportText(e.target.value)}
            disabled={isImporting}
            sx={{ mt: 2 }}
          />
          <Box sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', mt: 2 }}>
            <Button variant="plain" color="neutral" onClick={() => setImportModalOpen(false)} disabled={isImporting}>
              Cancel
            </Button>
            <Button
              variant="solid"
              color="primary"
              onClick={handleImport}
              disabled={isImporting}
              startDecorator={isImporting ? <CircularProgress size="sm" /> : null}
            >
              {isImporting ? 'Importing...' : 'Import'}
            </Button>
          </Box>
        </ModalDialog>
      </Modal>
    </Box>
  );
};

const MementosTabContent = () => {
  const { isFeatureEnabled } = useFeatureEnabled();
  // V2 is the unified view (the read path unions V1 mementos into the ledger), so when it is on it wins
  // regardless of V1. V1-only users still get the classic CRUD table.
  const v2Enabled = isFeatureEnabled('enableMementosV2');
  return (
    <ErrorBoundary
      fallback={
        <Box sx={{ p: 2 }}>
          <Typography level="h4">Failed to load Mementos. Please refresh or re-authenticate.</Typography>
        </Box>
      }
    >
      {v2Enabled ? <MementosV2Panel /> : <MementosTabContentInner />}
    </ErrorBoundary>
  );
};

export default MementosTabContent;
