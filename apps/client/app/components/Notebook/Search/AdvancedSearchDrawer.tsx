/**
 * Slide-out left panel with advanced search filters, semantic ("Deep") search,
 * and an admin-only Zen Garden batch-grooming tab.
 */

import {
  Box,
  Badge,
  Button,
  Drawer,
  IconButton,
  Stack,
  Typography,
  Divider,
  Chip,
  Input,
  CircularProgress,
  LinearProgress,
  Alert,
  Checkbox,
  Card,
  List,
  ListItem,
  ListItemContent,
  Slider,
  Tooltip,
  Tabs,
  TabList,
  Tab,
  Modal,
  ModalDialog,
  ModalClose,
} from '@mui/joy';
import CloseIcon from '@mui/icons-material/Close';
import SearchIcon from '@mui/icons-material/Search';
import ErrorIcon from '@mui/icons-material/Error';
import CalculateIcon from '@mui/icons-material/Calculate';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import SummarizeIcon from '@mui/icons-material/Summarize';
import LocalOfferIcon from '@mui/icons-material/LocalOffer';
import SmartToyIcon from '@mui/icons-material/SmartToy';

import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TuneIcon from '@mui/icons-material/Tune';
import { useNavigate } from '@tanstack/react-router';
import { useAdvancedSearch, useActiveFilters, useSemanticSearchState } from '@client/app/hooks/useAdvancedSearch';
import { SearchResultsMetadata } from '@client/app/types/NotebookSearchTypes';
import QuickFilters from './QuickFilters';
import DateRangePicker from './DateRangePicker';
import ContentSizeFilter from './ContentSizeFilter';
import SourceTypeFilter from './SourceTypeFilter';
import SearchResultsCounter from './SearchResultsCounter';
import { useSemanticSearch } from '@client/app/hooks/data/semanticSearch';
import { useState, useEffect, useRef } from 'react';
import PsychologyIcon from '@mui/icons-material/Psychology';
import ClearIcon from '@mui/icons-material/Clear';
import { useUser } from '@client/app/contexts/UserContext';
import SquareSlideToggle from '@client/app/components/SquareSlideToggle';
import { useQueryClient } from '@tanstack/react-query';
import { useAccessToken } from '@client/app/hooks/useAccessToken';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { toast } from 'sonner';
import { green, greenAlpha, gray, grayAlpha, brandAlpha } from '@client/app/utils/themes/colors';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import LowPriorityOutlinedIcon from '@mui/icons-material/LowPriorityOutlined';
import CalendarMonthOutlinedIcon from '@mui/icons-material/CalendarMonthOutlined';
import FilterListOutlinedIcon from '@mui/icons-material/FilterListOutlined';

interface AdvancedSearchDrawerProps {
  metadata: SearchResultsMetadata | null;
  isLoading?: boolean;
}

type SpiderOperation = 'messageCount' | 'curation' | 'summarize' | 'tags' | 'embeddings';

interface SpiderProgress {
  spiderJobId: string;
  notebooksProcessed: number;
  totalNotebooks: number;
  currentOperation: string;
  currentNotebookName?: string;
  dryRun?: boolean;
  stats?: {
    messageCountsUpdated: number;
    notebooksCurated: number;
    notebooksSummarized: number;
    notebooksTagged: number;
    messagesEmbedded?: number;
    errors?: number;
    skipped?: number;
  };
  error?: string;
  completed: boolean;
}

interface SpiderProgressEvent {
  spiderJobId: string;
  notebooksProcessed: number;
  totalNotebooks: number;
  currentOperation: string;
  currentNotebookName?: string;
  dryRun?: boolean;
}

interface SpiderCompleteEvent {
  spiderJobId: string;
  totalNotebooks: number;
  dryRun?: boolean;
  stats: SpiderProgress['stats'];
}

interface SpiderErrorEvent {
  spiderJobId: string;
  notebooksProcessed: number;
  error: string;
}

export default function AdvancedSearchDrawer({ metadata, isLoading = false }: AdvancedSearchDrawerProps) {
  const { isDrawerOpen, closeDrawer, resetFilters } = useAdvancedSearch();
  const { hasActive, count: activeFilterCount, filters: activeFilters } = useActiveFilters();
  const hasDateFilter = !!(
    activeFilters.dateRange.from ||
    activeFilters.dateRange.to ||
    (activeFilters.dateRange.preset && activeFilters.dateRange.preset !== 'custom')
  );
  const nonDateFilterCount = activeFilterCount - (hasDateFilter ? 1 : 0);
  const semanticSearch = useSemanticSearchState();
  const navigate = useNavigate();
  const { mutate: performSemanticSearch, isPending: isSemanticSearchPending } = useSemanticSearch();
  const { currentUser } = useUser();
  const queryClient = useQueryClient();
  const accessToken = useAccessToken(s => s.accessToken);
  const { subscribeToAction } = useWebsocket();
  const [isSpiderRunning, setIsSpiderRunning] = useState(false);
  const [spiderProgress, setSpiderProgress] = useState<SpiderProgress | null>(null);
  const [completionModalOpen, setCompletionModalOpen] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const [activeTab, setActiveTab] = useState<'filters' | 'zenGarden'>('filters');
  const isAdmin = !!currentUser?.isAdmin;

  // Zen Garden operation controls
  const [isDryRun, setIsDryRun] = useState(true); // Default to dry-run for safety
  const [selectedOperations, setSelectedOperations] = useState<SpiderOperation[]>([]);

  // Semantic search controls
  const [minSimilarity, setMinSimilarity] = useState(0.5);
  const [similarityOpen, setSimilarityOpen] = useState(false);
  const similarityRef = useRef<HTMLDivElement>(null);

  const getSimilarityLabel = (v: number) => {
    if (v < 0.5) return 'Broad';
    if (v === 0.5) return 'Balanced';
    return 'Precise';
  };
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [otherFilterOpen, setOtherFilterOpen] = useState(false);
  const dateFilterRef = useRef<HTMLDivElement>(null);
  const otherFilterRef = useRef<HTMLDivElement>(null);

  const toggleOperation = (op: SpiderOperation) => {
    setSelectedOperations(prev => (prev.includes(op) ? prev.filter(o => o !== op) : [...prev, op]));
  };

  // Handle semantic search on Enter key
  const handleSemanticSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && semanticSearch.query.trim().length > 0) {
      performSemanticSearch({ query: semanticSearch.query, minSimilarity, useReRanking: semanticSearch.useReRanking });
    }
  };

  const hasSemanticSearch = semanticSearch.results !== null;

  // Cleanup WebSocket subscription on unmount
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // Close similarity dropdown on outside click
  useEffect(() => {
    if (!similarityOpen) return;
    const handler = (e: MouseEvent) => {
      if (similarityRef.current && !similarityRef.current.contains(e.target as Node)) {
        setSimilarityOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [similarityOpen]);

  // Close date filter dropdown on outside click
  useEffect(() => {
    if (!dateFilterOpen) return;
    const handler = (e: MouseEvent) => {
      if (dateFilterRef.current && !dateFilterRef.current.contains(e.target as Node)) {
        setDateFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dateFilterOpen]);

  // Close other filter dropdown on outside click
  useEffect(() => {
    if (!otherFilterOpen) return;
    const handler = (e: MouseEvent) => {
      if (otherFilterRef.current && !otherFilterRef.current.contains(e.target as Node)) {
        setOtherFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [otherFilterOpen]);

  // WebSocket listener for Spider progress updates
  useEffect(() => {
    if (!spiderProgress || !isDrawerOpen) return;

    // Clean up any existing subscription first
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }

    const unsubscribe = subscribeToAction('spider_progress', async raw => {
      const data = raw as unknown as SpiderProgressEvent;
      if (data.spiderJobId !== spiderProgress.spiderJobId) return;

      setSpiderProgress(prev =>
        prev
          ? {
              ...prev,
              notebooksProcessed: data.notebooksProcessed,
              totalNotebooks: data.totalNotebooks,
              currentOperation: data.currentOperation,
              currentNotebookName: data.currentNotebookName,
              dryRun: data.dryRun,
            }
          : prev
      );
    });

    const unsubscribeComplete = subscribeToAction('spider_complete', async raw => {
      const data = raw as unknown as SpiderCompleteEvent;
      if (data.spiderJobId !== spiderProgress.spiderJobId) return;

      setSpiderProgress(prev =>
        prev
          ? {
              ...prev,
              completed: true,
              stats: data.stats,
              notebooksProcessed: data.totalNotebooks,
              dryRun: data.dryRun,
            }
          : prev
      );

      setIsSpiderRunning(false);
      setCompletionModalOpen(true);

      // Invalidate session queries to refresh the UI (only if not dry-run)
      if (!data.dryRun) {
        queryClient.invalidateQueries({ queryKey: ['sessions'] });
      }
    });

    const unsubscribeError = subscribeToAction('spider_error', async raw => {
      const data = raw as unknown as SpiderErrorEvent;
      if (data.spiderJobId !== spiderProgress.spiderJobId) return;

      setSpiderProgress(prev =>
        prev
          ? {
              ...prev,
              completed: true,
              error: data.error,
              notebooksProcessed: data.notebooksProcessed,
            }
          : prev
      );

      setIsSpiderRunning(false);
      setCompletionModalOpen(true);
    });

    unsubscribeRef.current = () => {
      unsubscribe();
      unsubscribeComplete();
      unsubscribeError();
    };

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [spiderProgress, isDrawerOpen, subscribeToAction, queryClient]);

  // Handle spider (comprehensive notebook grooming)
  const handleSpider = async () => {
    if (selectedOperations.length === 0) {
      toast.error('Please select at least one operation to run.');
      return;
    }

    setIsSpiderRunning(true);
    setSpiderProgress(null);

    try {
      const response = await fetch('/api/admin/recalculate-message-counts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: 'include',
        body: JSON.stringify({
          dryRun: isDryRun,
          operations: selectedOperations,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to start Spider job');
      }

      // Initialize progress tracking
      setSpiderProgress({
        spiderJobId: data.spiderJobId,
        notebooksProcessed: 0,
        totalNotebooks: data.totalNotebooks,
        currentOperation: 'Starting...',
        dryRun: data.dryRun,
        completed: false,
      });
    } catch (error) {
      console.error('Spider error:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to start Spider job');
      setIsSpiderRunning(false);
    }
  };

  return (
    <>
      <Drawer
        open={isDrawerOpen}
        onClose={closeDrawer}
        anchor="left"
        size="lg"
        disableEscapeKeyDown={false}
        slotProps={{
          content: {
            sx: {
              width: { xs: '95vw', sm: '700px', md: '800px', lg: '900px' },
              bgcolor: 'background.panel',
              boxShadow: 'lg',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
            },
          },
          backdrop: {
            sx: {
              backdropFilter: 'blur(4px)',
              backgroundColor: 'rgba(0, 0, 0, 0.2)',
            },
          },
        }}
      >
        {/* Top Bar: Tabs (admin) + Close Button */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 3,
            pt: 3,
            pb: 1,
            gap: 1,
          }}
        >
          {isAdmin ? (
            <Tabs
              value={activeTab}
              onChange={(_, value) => setActiveTab(value as 'filters' | 'zenGarden')}
              sx={{ bgcolor: 'transparent', flex: 1 }}
            >
              <TabList
                sx={{
                  gap: '8px',
                  '& .MuiTab-root': {
                    '&:not(.Mui-selected):hover': {
                      backgroundColor: theme => `${theme.palette.notebooklist.hoverBg} !important`,
                      color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70'),
                    },
                    '&.Mui-selected': {
                      color: theme => (theme.palette.mode === 'dark' ? '#D1E4F4' : '#335F70'),
                    },
                  },
                }}
              >
                <Tab value="filters">Advanced Search</Tab>
                <Tab value="zenGarden">Zen Garden Grooming</Tab>
              </TabList>
            </Tabs>
          ) : (
            <Box />
          )}
          <IconButton
            size="sm"
            variant="plain"
            onClick={closeDrawer}
            sx={{
              mr: '-16px',
              mt: '-24px',
              '--Icon-color': 'var(--joy-palette-text-tertiary)',
              transition: '--Icon-color 0.15s ease',
              '& svg': { transition: 'color 0.15s ease' },
              '&:hover': {
                bgcolor: 'transparent',
                '--Icon-color': 'var(--joy-palette-text-primary)',
              },
            }}
          >
            <CloseIcon />
          </IconButton>
        </Box>

        {/* Zen Garden Tab Panel (admin only) */}
        {isAdmin && activeTab === 'zenGarden' && (
          <>
            <Box sx={{ flex: 1, overflowY: 'auto', px: 3, pt: 2, pb: 3 }}>
              <Card
                variant="plain"
                sx={{
                  p: 0,
                  gap: 0,
                  bgcolor: 'transparent',
                  border: 'none',
                  boxShadow: 'none',
                }}
              >
                <Box sx={{ mb: 3, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 2 }}>
                  <Box>
                    <Typography sx={{ fontSize: '16px', color: 'text.primary', fontWeight: 'md', mb: 0.5 }}>
                      Notebooks Operations
                    </Typography>
                    <Typography sx={{ fontSize: '14px', color: 'text.tertiary', mb: '20px' }}>
                      Process all notebooks with selected operations.
                      <br />
                      Use Preview Mode to see what would happen without making changes.
                    </Typography>
                    <Typography
                      sx={{ fontSize: '16px', fontWeight: 600, color: isDryRun ? 'primary.500' : 'danger.500' }}
                    >
                      {isDryRun
                        ? 'Preview mode — no changes will be made'
                        : 'Live Mode On — changes will be applied to all notebooks'}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                    <Typography sx={{ fontSize: '14px', color: 'text.primary' }}>Live Mode</Typography>
                    <SquareSlideToggle
                      checked={!isDryRun}
                      onChange={e => setIsDryRun(!e.target.checked)}
                      disabled={isSpiderRunning}
                    />
                  </Box>
                </Box>
                <Stack spacing={1.5} sx={{ mb: 2 }}>
                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme =>
                        selectedOperations.includes('messageCount')
                          ? 'primary.outlinedBorder'
                          : theme.palette.mode === 'dark'
                            ? theme.palette.border.soft
                            : brandAlpha[100][50],
                      bgcolor: theme =>
                        selectedOperations.includes('messageCount')
                          ? brandAlpha[500][10]
                          : theme.palette.mode === 'dark'
                            ? 'background.surface'
                            : gray[0],
                      cursor: isSpiderRunning ? 'not-allowed' : 'pointer',
                      opacity: isSpiderRunning ? 0.6 : 1,
                      transition: 'background-color 0.15s ease',
                      '&:hover': isSpiderRunning
                        ? {}
                        : {
                            bgcolor: selectedOperations.includes('messageCount')
                              ? brandAlpha[500][15]
                              : theme => (theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12]),
                          },
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <CalculateIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Message Counts
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Recalculate message counts for all notebooks
                        </Typography>
                      </Box>
                    </Box>
                    <Checkbox
                      size="sm"
                      checked={selectedOperations.includes('messageCount')}
                      disabled={isSpiderRunning}
                      onChange={() => toggleOperation('messageCount')}
                    />
                  </Box>

                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme =>
                        selectedOperations.includes('curation')
                          ? 'primary.outlinedBorder'
                          : theme.palette.mode === 'dark'
                            ? theme.palette.border.soft
                            : brandAlpha[100][50],
                      bgcolor: theme =>
                        selectedOperations.includes('curation')
                          ? brandAlpha[500][10]
                          : theme.palette.mode === 'dark'
                            ? 'background.surface'
                            : gray[0],
                      cursor: isSpiderRunning ? 'not-allowed' : 'pointer',
                      opacity: isSpiderRunning ? 0.6 : 1,
                      transition: 'background-color 0.15s ease',
                      '&:hover': isSpiderRunning
                        ? {}
                        : {
                            bgcolor: selectedOperations.includes('curation')
                              ? brandAlpha[500][15]
                              : theme => (theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12]),
                          },
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <AutoFixHighIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Curation
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Generate curated transcripts for uncurated notebooks
                        </Typography>
                      </Box>
                    </Box>
                    <Checkbox
                      size="sm"
                      checked={selectedOperations.includes('curation')}
                      disabled={isSpiderRunning}
                      onChange={() => toggleOperation('curation')}
                    />
                  </Box>

                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme =>
                        selectedOperations.includes('summarize')
                          ? 'primary.outlinedBorder'
                          : theme.palette.mode === 'dark'
                            ? theme.palette.border.soft
                            : brandAlpha[100][50],
                      bgcolor: theme =>
                        selectedOperations.includes('summarize')
                          ? brandAlpha[500][10]
                          : theme.palette.mode === 'dark'
                            ? 'background.surface'
                            : gray[0],
                      cursor: isSpiderRunning ? 'not-allowed' : 'pointer',
                      opacity: isSpiderRunning ? 0.6 : 1,
                      transition: 'background-color 0.15s ease',
                      '&:hover': isSpiderRunning
                        ? {}
                        : {
                            bgcolor: selectedOperations.includes('summarize')
                              ? brandAlpha[500][15]
                              : theme => (theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12]),
                          },
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <SummarizeIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Summarization
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Generate AI summaries for unsummarized notebooks
                        </Typography>
                      </Box>
                    </Box>
                    <Checkbox
                      size="sm"
                      checked={selectedOperations.includes('summarize')}
                      disabled={isSpiderRunning}
                      onChange={() => toggleOperation('summarize')}
                    />
                  </Box>

                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme =>
                        selectedOperations.includes('tags')
                          ? 'primary.outlinedBorder'
                          : theme.palette.mode === 'dark'
                            ? theme.palette.border.soft
                            : brandAlpha[100][50],
                      bgcolor: theme =>
                        selectedOperations.includes('tags')
                          ? brandAlpha[500][10]
                          : theme.palette.mode === 'dark'
                            ? 'background.surface'
                            : gray[0],
                      cursor: isSpiderRunning ? 'not-allowed' : 'pointer',
                      opacity: isSpiderRunning ? 0.6 : 1,
                      transition: 'background-color 0.15s ease',
                      '&:hover': isSpiderRunning
                        ? {}
                        : {
                            bgcolor: selectedOperations.includes('tags')
                              ? brandAlpha[500][15]
                              : theme => (theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12]),
                          },
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <LocalOfferIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Auto-Tagging
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Generate AI tags for untagged notebooks
                        </Typography>
                      </Box>
                    </Box>
                    <Checkbox
                      size="sm"
                      checked={selectedOperations.includes('tags')}
                      disabled={isSpiderRunning}
                      onChange={() => toggleOperation('tags')}
                    />
                  </Box>

                  {/* Embeddings */}
                  <Box
                    component="label"
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme =>
                        selectedOperations.includes('embeddings')
                          ? 'primary.outlinedBorder'
                          : theme.palette.mode === 'dark'
                            ? theme.palette.border.soft
                            : brandAlpha[100][50],
                      bgcolor: theme =>
                        selectedOperations.includes('embeddings')
                          ? brandAlpha[500][10]
                          : theme.palette.mode === 'dark'
                            ? 'background.surface'
                            : gray[0],
                      cursor: isSpiderRunning ? 'not-allowed' : 'pointer',
                      opacity: isSpiderRunning ? 0.5 : 1,
                      transition: 'background-color 0.15s ease',
                      '&:hover': isSpiderRunning
                        ? {}
                        : {
                            bgcolor: selectedOperations.includes('embeddings')
                              ? brandAlpha[500][15]
                              : theme => (theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12]),
                          },
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <PsychologyIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Semantic Embeddings
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Pre-compute embeddings for instant semantic search
                        </Typography>
                      </Box>
                    </Box>
                    <Checkbox
                      size="sm"
                      checked={selectedOperations.includes('embeddings')}
                      disabled={isSpiderRunning}
                      onChange={() => toggleOperation('embeddings')}
                    />
                  </Box>

                  {/* Tag Filters - Coming Soon */}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme => theme.palette.border.soft,
                      bgcolor: theme => (theme.palette.mode === 'dark' ? 'background.surface' : gray[0]),
                      opacity: 0.5,
                      cursor: 'not-allowed',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <LocalOfferIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          Tag Filters
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Multi-select with autocomplete
                        </Typography>
                      </Box>
                    </Box>
                    <Typography sx={{ fontSize: '12px', fontWeight: 500, color: 'text.tertiary' }}>
                      Coming Soon
                    </Typography>
                  </Box>

                  {/* AI Model Filter - Coming Soon */}
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      py: '16px',
                      px: '20px',
                      borderRadius: '8px',
                      border: '1px solid',
                      borderColor: theme => theme.palette.border.soft,
                      bgcolor: theme => (theme.palette.mode === 'dark' ? 'background.surface' : gray[0]),
                      opacity: 0.5,
                      cursor: 'not-allowed',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Box
                        sx={{
                          width: 32,
                          height: 32,
                          borderRadius: '8px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <SmartToyIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                      </Box>
                      <Box>
                        <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                          AI Model Filter
                        </Typography>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                          Filter by Claude, GPT-4, etc.
                        </Typography>
                      </Box>
                    </Box>
                    <Typography sx={{ fontSize: '12px', fontWeight: 500, color: 'text.tertiary' }}>
                      Coming Soon
                    </Typography>
                  </Box>
                </Stack>
              </Card>
            </Box>

            {/* Sticky bottom action bar */}
            {selectedOperations.length > 0 && (
              <Box
                sx={{
                  flexShrink: 0,
                  p: 3,
                  borderTop: '1px solid',
                  borderColor: 'divider',
                  bgcolor: 'background.panel',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
                  {/* Left: progress bar while running */}
                  {isSpiderRunning && spiderProgress ? (
                    <Box sx={{ flex: 1, maxWidth: '35%' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                        <Typography level="body-xs" sx={{ fontWeight: 'md', color: 'text.secondary' }}>
                          {spiderProgress.dryRun ? 'Previewing...' : 'Processing...'}
                        </Typography>
                        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                          {spiderProgress.totalNotebooks > 0
                            ? Math.min(
                                Math.round((spiderProgress.notebooksProcessed / spiderProgress.totalNotebooks) * 100),
                                100
                              )
                            : 0}
                          %
                        </Typography>
                      </Box>
                      <LinearProgress
                        determinate
                        value={
                          spiderProgress.totalNotebooks > 0
                            ? Math.min((spiderProgress.notebooksProcessed / spiderProgress.totalNotebooks) * 100, 100)
                            : 0
                        }
                        color={spiderProgress.dryRun ? 'warning' : 'primary'}
                        sx={{ borderRadius: '4px' }}
                      />
                    </Box>
                  ) : (
                    <Box />
                  )}

                  {/* Right: buttons */}
                  <Box sx={{ display: 'flex', gap: 1, flexShrink: 0 }}>
                    <Button
                      size="sm"
                      variant="outlined"
                      onClick={() => setSelectedOperations([])}
                      disabled={isSpiderRunning}
                      sx={theme => ({
                        height: '36px',
                        minHeight: '36px',
                        px: 2,
                        fontSize: '14px',
                        fontWeight: 500,
                        color: 'text.primary',
                        border: `1px solid ${theme.palette.border.input}`,
                        backgroundColor: theme.palette.background.body,
                        '&:hover': {
                          bgcolor: theme.palette.notebooklist.hoverBg,
                          borderColor: theme.palette.border.input,
                        },
                      })}
                    >
                      Deselect All
                    </Button>
                    <Button
                      size="sm"
                      variant={isDryRun ? 'solid' : 'soft'}
                      color={isDryRun ? 'primary' : 'danger'}
                      onClick={handleSpider}
                      disabled={isSpiderRunning}
                      startDecorator={
                        isSpiderRunning ? (
                          <CircularProgress
                            sx={{
                              '--CircularProgress-size': '14px',
                              '--CircularProgress-trackThickness': '2px',
                              '--CircularProgress-progressThickness': '2px',
                            }}
                          />
                        ) : undefined
                      }
                      sx={{ height: '36px', minHeight: '36px', px: 2, fontSize: '14px' }}
                    >
                      {isSpiderRunning
                        ? isDryRun
                          ? 'Previewing...'
                          : 'Executing...'
                        : isDryRun
                          ? `Preview ${selectedOperations.length} Operation${selectedOperations.length !== 1 ? 's' : ''}`
                          : `Run ${selectedOperations.length} Operation${selectedOperations.length !== 1 ? 's' : ''}`}
                    </Button>
                  </Box>
                </Box>
              </Box>
            )}
          </>
        )}

        {/* Filters Tab Content (default for non-admin, tab 1 for admin) */}
        {(!isAdmin || activeTab === 'filters') && (
          <>
            {/* Search Inputs - Full Width at Top (sticky) */}
            <Box sx={{ flexShrink: 0, pt: 2, px: 3, pb: 1.5 }}>
              <Stack spacing={2}>
                {/* Search input - always semantic */}
                <Input
                  placeholder="Search across all message content"
                  value={semanticSearch.query}
                  onChange={e => semanticSearch.setQuery(e.target.value)}
                  onKeyDown={handleSemanticSearchKeyDown}
                  startDecorator={
                    semanticSearch.isSearching || isSemanticSearchPending ? (
                      <CircularProgress size="sm" />
                    ) : (
                      <SearchIcon sx={{ color: 'text.tertiary' }} />
                    )
                  }
                  endDecorator={
                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                      {(semanticSearch.query || hasSemanticSearch) && (
                        <IconButton
                          size="sm"
                          variant="plain"
                          color="neutral"
                          onClick={() => semanticSearch.clear()}
                          disabled={semanticSearch.isSearching || isSemanticSearchPending}
                        >
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      )}
                      <Button
                        size="sm"
                        variant="solid"
                        color="primary"
                        disabled={
                          semanticSearch.isSearching ||
                          isSemanticSearchPending ||
                          semanticSearch.query.trim().length === 0
                        }
                        onClick={() => {
                          if (semanticSearch.query.trim().length > 0) {
                            performSemanticSearch({
                              query: semanticSearch.query,
                              minSimilarity,
                              useReRanking: semanticSearch.useReRanking,
                            });
                          }
                        }}
                        sx={{ borderRadius: 'sm', height: 32, minHeight: 32 }}
                      >
                        Deep Search
                      </Button>
                    </Box>
                  }
                  size="md"
                  data-testid="semantic-search-input"
                  disabled={semanticSearch.isSearching || isSemanticSearchPending}
                  sx={theme => ({
                    '--Input-focusedThickness': '0px',
                    '--Input-focusedHighlight': 'transparent',
                    '--Input-minHeight': '48px',
                    boxShadow: 'none',
                    bgcolor: theme.palette.mode === 'light' ? '#FFFFFF' : undefined,
                    borderColor: hasSemanticSearch ? 'primary.outlinedBorder' : undefined,
                    '& input::placeholder': { color: 'var(--joy-palette-text-tertiary)' },
                    '&.Mui-disabled': {
                      borderColor: hasSemanticSearch ? 'primary.outlinedBorder' : 'neutral.outlinedBorder',
                    },
                  })}
                />

                {/* Re-rank + similarity controls */}
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 3 }}>
                  {/* Re-rank toggle */}
                  <Tooltip title="Use LLM to verify result relevance (slower but more accurate)" placement="top">
                    <Button
                      size="sm"
                      variant="outlined"
                      color="neutral"
                      onClick={semanticSearch.toggleReRanking}
                      data-testid="rerank-toggle"
                      startDecorator={
                        <LowPriorityOutlinedIcon
                          sx={{
                            fontSize: 15,
                            opacity: semanticSearch.useReRanking ? 1 : 0.5,
                            color: semanticSearch.useReRanking ? green[800] : undefined,
                          }}
                        />
                      }
                      sx={theme => ({
                        height: 32,
                        minHeight: 32,
                        px: 2,
                        gap: '4px',
                        fontSize: '13px',
                        borderRadius: '60px',
                        color: semanticSearch.useReRanking ? green[800] : 'text.primary',
                        borderColor: semanticSearch.useReRanking
                          ? green[800]
                          : theme.palette.mode === 'dark'
                            ? brandAlpha[100][12]
                            : grayAlpha[150][50],
                        bgcolor: semanticSearch.useReRanking
                          ? greenAlpha[800][10]
                          : theme.palette.mode === 'dark'
                            ? gray[900]
                            : '#FFFFFF',
                        '&:hover': semanticSearch.useReRanking
                          ? { borderColor: green[800], bgcolor: greenAlpha[800][10] }
                          : {
                              bgcolor: theme.palette.notebooklist.hoverBg,
                              borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                            },
                      })}
                    >
                      Re-rank
                    </Button>
                  </Tooltip>

                  {/* Similarity dropdown button */}
                  <Box ref={similarityRef} sx={{ position: 'relative' }}>
                    <Button
                      size="sm"
                      variant="outlined"
                      color="neutral"
                      onClick={() => setSimilarityOpen(o => !o)}
                      data-testid="similarity-toggle"
                      startDecorator={
                        <TuneIcon
                          sx={{
                            fontSize: 15,
                            opacity: minSimilarity !== 0.5 ? 1 : 0.5,
                            color: minSimilarity !== 0.5 ? green[800] : undefined,
                          }}
                        />
                      }
                      sx={theme => ({
                        height: 32,
                        minHeight: 32,
                        px: 2,
                        gap: '4px',
                        fontSize: '13px',
                        borderRadius: '60px',
                        color: minSimilarity !== 0.5 ? green[800] : 'text.primary',
                        borderColor:
                          minSimilarity !== 0.5
                            ? green[800]
                            : theme.palette.mode === 'dark'
                              ? brandAlpha[100][12]
                              : grayAlpha[150][50],
                        bgcolor:
                          minSimilarity !== 0.5
                            ? greenAlpha[800][10]
                            : theme.palette.mode === 'dark'
                              ? gray[900]
                              : '#FFFFFF',
                        '&:hover':
                          minSimilarity !== 0.5
                            ? { borderColor: green[800], bgcolor: greenAlpha[800][10] }
                            : {
                                bgcolor: theme.palette.notebooklist.hoverBg,
                                borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                              },
                      })}
                    >
                      {(minSimilarity * 100).toFixed(0)}%
                    </Button>

                    {similarityOpen && (
                      <Box
                        sx={theme => ({
                          position: 'absolute',
                          top: 'calc(100% + 6px)',
                          left: 0,
                          zIndex: 1300,
                          width: 280,
                          bgcolor: theme.palette.mode === 'dark' ? gray[900] : gray[0],
                          border: '1px solid',
                          borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          borderRadius: 'sm',
                          boxShadow: 'md',
                          p: 2,
                        })}
                      >
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
                          <Typography
                            level="body-xs"
                            sx={{
                              fontWeight: 'lg',
                              letterSpacing: '0.05em',
                              textTransform: 'uppercase',
                              color: 'text.secondary',
                            }}
                          >
                            Min Similarity
                          </Typography>
                          <Typography level="body-xs" sx={{ color: green[800], fontWeight: 'lg' }}>
                            {getSimilarityLabel(minSimilarity)} — {(minSimilarity * 100).toFixed(0)}%
                          </Typography>
                        </Box>
                        <Box sx={{ px: 0.5 }}>
                          <Slider
                            size="sm"
                            value={minSimilarity}
                            onChange={(_, value) => setMinSimilarity(value as number)}
                            min={0.3}
                            max={0.9}
                            step={0.05}
                            valueLabelDisplay="auto"
                            valueLabelFormat={v => `${(v * 100).toFixed(0)}%`}
                            marks={[
                              { value: 0.3, label: '30%' },
                              { value: 0.9, label: '90%' },
                            ]}
                            sx={{ width: '100%' }}
                          />
                        </Box>
                        <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 1, lineHeight: 1.5 }}>
                          Controls the minimum semantic similarity threshold. Lower values return more results but less
                          precise. Higher values show only close matches.
                        </Typography>
                        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>
                          <Button
                            variant="plain"
                            size="sm"
                            onClick={() => {
                              setMinSimilarity(0.5);
                              setSimilarityOpen(false);
                            }}
                            sx={{
                              color: 'text.tertiary',
                              fontSize: '13px',
                              fontWeight: 500,
                              minHeight: 'unset',
                              p: 0,
                              '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
                            }}
                          >
                            Reset
                          </Button>
                        </Box>
                      </Box>
                    )}
                  </Box>
                </Box>

                {/* Error display */}
                {semanticSearch.error && (
                  <Alert color="danger" variant="soft" size="sm">
                    {semanticSearch.error}
                  </Alert>
                )}
              </Stack>
              <Divider
                sx={theme => ({ mt: 3, bgcolor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : gray[150] })}
              />
            </Box>

            {/* Scrollable area: counter, filters, results */}
            <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'clip', display: 'flex', flexDirection: 'column' }}>
              {/* Results Counter + Filter Dropdowns */}
              <Box
                sx={{
                  pt: 1.5,
                  pb: 3,
                  px: 3,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 2,
                }}
              >
                <SearchResultsCounter metadata={metadata} isLoading={isLoading} showBreakdown={true} />

                {/* Filter dropdowns */}
                <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexShrink: 0, overflow: 'visible' }}>
                  {/* Clear all filters */}
                  {hasActive && (
                    <Button
                      variant="plain"
                      size="sm"
                      onClick={resetFilters}
                      sx={{
                        color: 'text.tertiary',
                        fontSize: '13px',
                        fontWeight: 500,
                        minHeight: 'unset',
                        p: 0,
                        '&:hover': { color: 'text.primary', bgcolor: 'transparent' },
                      }}
                    >
                      Clear Filters
                    </Button>
                  )}

                  {/* Date filter dropdown */}
                  <Box ref={dateFilterRef} sx={{ position: 'relative', overflow: 'visible' }}>
                    <Badge
                      badgeContent={1}
                      color="primary"
                      size="sm"
                      invisible={!hasDateFilter}
                      sx={{
                        '& .MuiBadge-badge': { right: 4, top: 4, fontSize: '12px', minWidth: '20px', height: '20px' },
                      }}
                    >
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        onClick={() => {
                          setDateFilterOpen(o => !o);
                          setOtherFilterOpen(false);
                        }}
                        startDecorator={<CalendarMonthOutlinedIcon sx={{ fontSize: 14, color: 'text.tertiary' }} />}
                        endDecorator={
                          <ExpandMoreIcon
                            sx={{
                              fontSize: 14,
                              color: 'text.tertiary',
                              transition: 'transform 0.2s ease-in-out',
                              transform: dateFilterOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            }}
                          />
                        }
                        sx={theme => ({
                          height: 32,
                          minHeight: 32,
                          pl: 2,
                          pr: 1.5,
                          gap: '4px',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 500,
                          '& .MuiButton-endDecorator': { marginLeft: '12px' },
                          bgcolor: theme.palette.mode === 'dark' ? gray[900] : '#FFFFFF',
                          borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          color: 'text.primary',
                          '&:hover': {
                            bgcolor: theme.palette.notebooklist.hoverBg,
                            borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          },
                        })}
                      >
                        Date
                      </Button>
                    </Badge>
                    {dateFilterOpen && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: 'calc(100% + 6px)',
                          right: 0,
                          zIndex: 1300,
                          width: 300,
                          bgcolor: theme => (theme.palette.mode === 'dark' ? gray[900] : gray[0]),
                          border: '1px solid',
                          borderColor: theme =>
                            theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          borderRadius: 'sm',
                          boxShadow: 'md',
                          px: 2,
                          py: 2.5,
                        }}
                      >
                        <DateRangePicker onClose={() => setDateFilterOpen(false)} />
                      </Box>
                    )}
                  </Box>

                  {/* Other filters dropdown */}
                  <Box ref={otherFilterRef} sx={{ position: 'relative', overflow: 'visible' }}>
                    <Badge
                      badgeContent={nonDateFilterCount}
                      color="primary"
                      size="sm"
                      invisible={nonDateFilterCount === 0}
                      sx={{
                        '& .MuiBadge-badge': {
                          right: 4,
                          top: 4,
                          fontSize: '12px',
                          minWidth: '20px',
                          height: '20px',
                        },
                      }}
                    >
                      <Button
                        size="sm"
                        variant="outlined"
                        color="neutral"
                        onClick={() => {
                          setOtherFilterOpen(o => !o);
                          setDateFilterOpen(false);
                        }}
                        startDecorator={<FilterListOutlinedIcon sx={{ fontSize: 14, color: 'text.tertiary' }} />}
                        endDecorator={
                          <ExpandMoreIcon
                            sx={{
                              fontSize: 14,
                              color: 'text.tertiary',
                              transition: 'transform 0.2s ease-in-out',
                              transform: otherFilterOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                            }}
                          />
                        }
                        sx={theme => ({
                          height: 32,
                          minHeight: 32,
                          pl: 2,
                          pr: 1.5,
                          gap: '4px',
                          borderRadius: '8px',
                          fontSize: '13px',
                          fontWeight: 500,
                          '& .MuiButton-endDecorator': { marginLeft: '12px' },
                          bgcolor: theme.palette.mode === 'dark' ? gray[900] : '#FFFFFF',
                          borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          color: 'text.primary',
                          '&:hover': {
                            bgcolor: theme.palette.notebooklist.hoverBg,
                            borderColor: theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          },
                        })}
                      >
                        Filters
                      </Button>
                    </Badge>
                    {otherFilterOpen && (
                      <Box
                        sx={{
                          position: 'absolute',
                          top: 'calc(100% + 6px)',
                          right: 0,
                          zIndex: 1300,
                          width: 320,
                          bgcolor: theme => (theme.palette.mode === 'dark' ? gray[900] : gray[0]),
                          border: '1px solid',
                          borderColor: theme =>
                            theme.palette.mode === 'dark' ? brandAlpha[100][12] : grayAlpha[150][50],
                          borderRadius: 'sm',
                          boxShadow: 'md',
                          px: 2,
                          py: 2.5,
                          maxHeight: '420px',
                          overflowY: 'scroll',
                          ...scrollbarStyles,
                        }}
                      >
                        <Stack spacing={3}>
                          <QuickFilters />
                          <ContentSizeFilter />
                          <SourceTypeFilter />
                        </Stack>
                      </Box>
                    )}
                  </Box>
                </Box>
              </Box>

              {/* Loading state */}
              {(semanticSearch.isSearching || isSemanticSearchPending) && (
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <CircularProgress size="sm" />
                </Box>
              )}

              {/* Empty state */}
              {!semanticSearch.results && !semanticSearch.isSearching && !isSemanticSearchPending && (
                <Box
                  sx={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 2,
                  }}
                >
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: '10px',
                      bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <SearchIcon sx={{ fontSize: 18, color: 'text.tertiary' }} />
                  </Box>
                  <Box sx={{ textAlign: 'center' }}>
                    <Typography sx={{ fontSize: '13px', color: 'text.tertiary', lineHeight: 1.5 }}>
                      Type a query and search
                    </Typography>
                    <Typography sx={{ fontSize: '13px', color: 'text.tertiary', lineHeight: 1.5 }}>
                      Search by title, content, or topic ...
                    </Typography>
                  </Box>
                </Box>
              )}

              {/* Search results list */}
              {semanticSearch.debugInfo && semanticSearch.debugInfo.scores.length > 0 && (
                <Box sx={{ px: 3, pb: 2 }}>
                  <Typography level="body-sm" sx={{ mb: 1.5 }}>
                    <Typography component="span" sx={{ color: 'text.tertiary' }}>
                      {semanticSearch.debugInfo.hybridMode ? 'Hybrid' : 'Semantic'} Matches:{' '}
                    </Typography>
                    <Typography component="span" sx={{ color: 'text.primary', fontWeight: 500 }}>
                      {semanticSearch.debugInfo.scores.length}
                    </Typography>
                  </Typography>
                  <List
                    size="sm"
                    sx={{
                      '--ListItem-paddingY': '16px',
                      '--ListItem-paddingX': '16px',
                      '--ListItemDecorator-size': '32px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 2,
                    }}
                  >
                    {semanticSearch.debugInfo.scores.map(score => (
                      <ListItem
                        key={score.sessionId}
                        onClick={() => navigate({ to: '/notebooks/$id', params: { id: score.sessionId } })}
                        sx={theme => ({
                          borderRadius: '8px',
                          border: '1px solid',
                          borderColor: theme.palette.border.soft,
                          bgcolor: theme.palette.mode === 'dark' ? gray[900] : gray[0],
                          cursor: 'pointer',
                          transition: 'background-color 0.15s ease',
                          '&:hover': {
                            bgcolor: theme.palette.mode === 'dark' ? grayAlpha[775][30] : brandAlpha[100][12],
                          },
                        })}
                      >
                        <ListItemContent>
                          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5 }}>
                            <Typography sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
                              {score.sessionName || 'Untitled'}
                            </Typography>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                                {score.matchingMessages} matching message{score.matchingMessages !== 1 ? 's' : ''}
                              </Typography>
                              <Chip
                                size="sm"
                                variant="soft"
                                color={
                                  score.maxSimilarity >= 0.7
                                    ? 'success'
                                    : score.maxSimilarity >= 0.6
                                      ? 'warning'
                                      : 'neutral'
                                }
                              >
                                {(score.maxSimilarity * 100).toFixed(1)}%
                              </Chip>
                            </Box>
                          </Box>
                          {score.bestMatch && (
                            <Typography
                              level="body-md"
                              sx={{
                                color: 'text.primary',
                                bgcolor: 'chatbox.replyBg',
                                p: 1.5,
                                borderRadius: '6px',
                                fontSize: '13px',
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                              }}
                            >
                              {score.bestMatch.snippet}
                            </Typography>
                          )}
                        </ListItemContent>
                      </ListItem>
                    ))}
                  </List>
                </Box>
              )}
            </Box>
            {/* end scrollable area */}
          </>
        )}
      </Drawer>

      {/* Completion Modal */}
      <Modal open={completionModalOpen} onClose={() => setCompletionModalOpen(false)}>
        <ModalDialog
          variant="outlined"
          sx={{
            width: 480,
            maxWidth: '90vw',
            maxHeight: '70vh',
            borderRadius: '12px',
            p: 0,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <ModalClose sx={{ top: 16, right: 16 }} />

          {/* Header */}
          <Box
            sx={{
              px: 3,
              pt: 3,
              pb: 2,
            }}
          >
            <Typography sx={{ fontSize: '16px', fontWeight: 600, color: 'text.primary', mb: '4px' }}>
              {spiderProgress?.error
                ? 'Operation Failed'
                : spiderProgress?.dryRun
                  ? 'Preview Complete'
                  : 'Mission Accomplished'}
            </Typography>
            <Typography
              sx={{
                fontSize: '14px',
                color: 'text.tertiary',
                mb: spiderProgress?.dryRun && !spiderProgress?.error ? '16px' : 0,
              }}
            >
              {spiderProgress?.error
                ? 'An error occurred while running the operation'
                : spiderProgress?.dryRun
                  ? 'No changes were made — this is what would happen'
                  : 'All selected operations were applied successfully'}
            </Typography>
            {spiderProgress?.dryRun && !spiderProgress?.error && (
              <Typography sx={{ fontSize: '14px', fontWeight: 600, color: 'primary.500', mt: '4px' }}>
                Turn off Preview Mode and run again to apply changes.
              </Typography>
            )}
          </Box>

          {/* Stats body */}
          <Box sx={{ px: 3, pb: 2, overflowY: 'auto', flex: 1 }}>
            {spiderProgress?.error ? (
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  p: '12px',
                  borderRadius: '8px',
                  bgcolor: theme =>
                    theme.palette.mode === 'dark' ? 'rgba(211, 47, 47, 0.08)' : 'rgba(211, 47, 47, 0.05)',
                  border: '1px solid',
                  borderColor: 'danger.outlinedBorder',
                  gap: '12px',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <Box
                    sx={{
                      width: 28,
                      height: 28,
                      borderRadius: '4px',
                      bgcolor: 'danger.softBg',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <ErrorIcon sx={{ fontSize: 16, color: 'danger.500' }} />
                  </Box>
                  <Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary', mb: '2px' }}>
                      Operation Error
                    </Typography>
                    <Typography sx={{ fontSize: '12px', color: 'text.tertiary', lineHeight: 1.4 }}>
                      {spiderProgress.error}
                    </Typography>
                  </Box>
                </Box>
                <Typography sx={{ fontSize: '13px', fontWeight: 600, color: 'danger.500', flexShrink: 0 }}>
                  ✗ Failed
                </Typography>
              </Box>
            ) : spiderProgress?.stats ? (
              <Stack spacing={2}>
                {selectedOperations.includes('messageCount') && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: 'background.panel',
                      border: '1px solid',
                      borderColor: theme =>
                        theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <CalculateIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>
                        Message Counts
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: green[800] }}>
                      {spiderProgress.dryRun ? '→ ' : '✓ '}
                      {spiderProgress.stats.messageCountsUpdated} updated
                    </Typography>
                  </Box>
                )}
                {selectedOperations.includes('curation') && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: 'background.panel',
                      border: '1px solid',
                      borderColor: theme =>
                        theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <AutoFixHighIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>
                        Curation
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: green[800] }}>
                      {spiderProgress.dryRun ? '→ ' : '✓ '}
                      {spiderProgress.stats.notebooksCurated} curated
                    </Typography>
                  </Box>
                )}
                {selectedOperations.includes('summarize') && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: 'background.panel',
                      border: '1px solid',
                      borderColor: theme =>
                        theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <SummarizeIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>
                        Summarization
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: green[800] }}>
                      {spiderProgress.dryRun ? '→ ' : '✓ '}
                      {spiderProgress.stats.notebooksSummarized} summarized
                    </Typography>
                  </Box>
                )}
                {selectedOperations.includes('tags') && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: 'background.panel',
                      border: '1px solid',
                      borderColor: theme =>
                        theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <LocalOfferIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>
                        Auto-Tagging
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: green[800] }}>
                      {spiderProgress.dryRun ? '→ ' : '✓ '}
                      {spiderProgress.stats.notebooksTagged} tagged
                    </Typography>
                  </Box>
                )}
                {selectedOperations.includes('embeddings') &&
                  spiderProgress.stats.messagesEmbedded !== undefined &&
                  spiderProgress.stats.messagesEmbedded > 0 && (
                    <Box
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        p: '12px',
                        borderRadius: '8px',
                        bgcolor: 'background.panel',
                        border: '1px solid',
                        borderColor: theme =>
                          theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <Box
                          sx={{
                            width: 28,
                            height: 28,
                            borderRadius: '4px',
                            bgcolor: theme =>
                              theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8],
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0,
                          }}
                        >
                          <PsychologyIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                        </Box>
                        <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>
                          Semantic Embeddings
                        </Typography>
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 600, color: green[800] }}>
                        {spiderProgress.dryRun ? '→ ' : '✓ '}
                        {spiderProgress.stats.messagesEmbedded} embedded
                      </Typography>
                    </Box>
                  )}

                {((spiderProgress.stats.skipped ?? 0) > 0 || (spiderProgress.stats.errors ?? 0) > 0) && (
                  <Box
                    sx={{
                      height: '1px',
                      bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : gray[150]),
                    }}
                  />
                )}

                {/* Skipped row */}
                {(spiderProgress.stats.skipped ?? 0) > 0 && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: 'background.panel',
                      border: '1px solid',
                      borderColor: theme =>
                        theme.palette.mode === 'dark' ? theme.palette.border.soft : brandAlpha[100][50],
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: theme => (theme.palette.mode === 'dark' ? brandAlpha[100][12] : brandAlpha[400][8]),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'text.tertiary' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.tertiary' }}>
                        Already Done
                      </Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: 'text.tertiary' }}>
                      {spiderProgress.stats.skipped} skipped
                    </Typography>
                  </Box>
                )}

                {/* Errors row */}
                {(spiderProgress.stats.errors ?? 0) > 0 && (
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      p: '12px',
                      borderRadius: '8px',
                      bgcolor: theme =>
                        theme.palette.mode === 'dark' ? 'rgba(211, 47, 47, 0.08)' : 'rgba(211, 47, 47, 0.05)',
                      border: '1px solid',
                      borderColor: 'danger.outlinedBorder',
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                      <Box
                        sx={{
                          width: 28,
                          height: 28,
                          borderRadius: '4px',
                          bgcolor: 'danger.softBg',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <ErrorIcon sx={{ fontSize: 16, color: 'danger.500' }} />
                      </Box>
                      <Typography sx={{ fontSize: '13px', fontWeight: 500, color: 'text.primary' }}>Errors</Typography>
                    </Box>
                    <Typography sx={{ fontSize: '13px', fontWeight: 600, color: 'danger.500' }}>
                      ✗ {spiderProgress.stats.errors} failed
                    </Typography>
                  </Box>
                )}
              </Stack>
            ) : null}
          </Box>

          {/* Footer */}
          <Box
            sx={{
              px: 3,
              py: 2,
              borderTop: '1px solid',
              borderColor: 'divider',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <Button
              size="sm"
              variant="outlined"
              onClick={() => setCompletionModalOpen(false)}
              sx={theme => ({
                height: '36px',
                minHeight: '36px',
                px: 2,
                fontSize: '14px',
                fontWeight: 500,
                color: 'text.primary',
                border: `1px solid ${theme.palette.border.input}`,
                backgroundColor: theme.palette.background.body,
                '&:hover': {
                  bgcolor: theme.palette.notebooklist.hoverBg,
                  borderColor: theme.palette.border.input,
                },
              })}
            >
              Done
            </Button>
          </Box>
        </ModalDialog>
      </Modal>
    </>
  );
}
