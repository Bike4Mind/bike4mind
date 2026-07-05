import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';
import {
  Alert,
  Box,
  Card,
  Typography,
  Chip,
  LinearProgress,
  Button,
  Stack,
  Input,
  IconButton,
  Tooltip,
  CardContent,
  CardActions,
  Modal,
  ModalDialog,
  ModalClose,
  FormControl,
  FormLabel,
  Textarea,
  DialogTitle,
  DialogContent,
  DialogActions,
  Divider,
} from '@mui/joy';
import {
  Search as SearchIcon,
  Add as AddIcon,
  PlayArrow as PlayIcon,
  Archive as ArchiveIcon,
  Refresh as RefreshIcon,
  Pause as PauseIcon,
  CheckCircle as CheckCircleIcon,
  WarningRounded as WarningIcon,
  Download as DownloadIcon,
  Close as CloseIcon,
} from '@mui/icons-material';
import { toast } from 'sonner';
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useDebounceValue } from '@client/app/hooks/useDebouncedValue';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { ContextHelpButton } from '@client/app/components/help';
import { useQuestExport } from '@client/app/hooks/data/useQuestExport';

dayjs.extend(relativeTime);

// Error fallback component for individual quest cards
const QuestCardErrorFallback = ({ planId, onRetry }: { planId: string; onRetry: () => void }) => (
  <Card
    data-testid={`quest-card-error-${planId}`}
    sx={{ minHeight: 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
  >
    <CardContent sx={{ textAlign: 'center' }}>
      <Typography level="body-sm" color="danger" sx={{ mb: 1 }}>
        Failed to render this quest
      </Typography>
      <Button size="sm" variant="soft" color="neutral" onClick={onRetry}>
        Retry
      </Button>
    </CardContent>
  </Card>
);

interface QuestPlan {
  id: string;
  notebookId: string;
  goal: string;
  state: 'draft' | 'active' | 'paused' | 'completed' | 'archived';
  visibility: 'session' | 'user' | 'team' | 'public';
  metrics?: {
    totalTimeSpent: number;
    completionRate: number;
    subQuestsCompleted: number;
    subQuestsTotal: number;
  };
  tags?: string[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  lastAccessedAt: Date;
  createdAt: Date;
}

interface QuestPlansResponse {
  data: QuestPlan[];
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasMore: boolean;
  };
  stats: {
    active: number;
    paused: number;
    completed: number;
    archived: number;
    totalTimeSpent: number;
  };
}

// Helper to parse API error messages for better UX
const getErrorMessage = (error: Error, fallbackMessage: string): string => {
  const message = error.message || '';
  if (message.includes('403') || message.includes('Access denied')) {
    return "You don't have permission to perform this action";
  }
  if (message.includes('404') || message.includes('not found')) {
    return 'Quest not found - it may have been deleted';
  }
  if (message.includes('401') || message.includes('Unauthorized')) {
    return 'Please sign in to continue';
  }
  if (message.includes('429') || message.includes('rate limit')) {
    return 'Too many requests. Please wait a moment and try again';
  }
  return fallbackMessage;
};

type FilterState = 'all' | 'active' | 'paused' | 'completed' | 'archived';

function QuestsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Use URL search params for filter state (enables shareable URLs)
  const searchParams = useSearch({ strict: false }) as { filter?: string; search?: string };
  const filterState = (searchParams.filter as FilterState) || 'active';
  const urlSearchTerm = searchParams.search || '';

  // Local search input state with debounce using shared hook
  const {
    value: searchInput,
    debouncedValue: debouncedSearch,
    setValue: setSearchInput,
  } = useDebounceValue(urlSearchTerm, 300);

  // Sync debounced search to URL
  useEffect(() => {
    if (debouncedSearch !== urlSearchTerm) {
      navigate({
        to: '/quests',
        search: {
          filter: filterState === 'active' ? undefined : filterState,
          search: debouncedSearch || undefined,
        },
        replace: true,
      });
    }
  }, [debouncedSearch, filterState, navigate, urlSearchTerm]);

  // Modal states
  const [newQuestModalOpen, setNewQuestModalOpen] = useState(false);
  const [newQuestGoal, setNewQuestGoal] = useState('');

  // Confirmation dialog state for archive action
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [questToArchive, setQuestToArchive] = useState<QuestPlan | null>(null);

  // Quest export hook
  const questExport = useQuestExport();

  // Refs for focus management (accessibility)
  const newQuestButtonRef = useRef<HTMLButtonElement>(null);
  const newQuestGoalInputRef = useRef<HTMLTextAreaElement>(null);
  const archiveTriggerRef = useRef<HTMLElement | null>(null);
  const archiveCancelButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the textarea when new quest modal opens
  useEffect(() => {
    if (newQuestModalOpen && newQuestGoalInputRef.current) {
      // Small delay to ensure modal is fully rendered
      const timeoutId = setTimeout(() => {
        newQuestGoalInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [newQuestModalOpen]);

  // Focus the cancel button when archive modal opens (safer default for destructive action)
  useEffect(() => {
    if (archiveConfirmOpen && archiveCancelButtonRef.current) {
      const timeoutId = setTimeout(() => {
        archiveCancelButtonRef.current?.focus();
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [archiveConfirmOpen]);

  // Helper to update filter state via URL
  const setFilterState = useCallback(
    (newFilter: FilterState) => {
      navigate({
        to: '/quests',
        search: {
          filter: newFilter === 'active' ? undefined : newFilter,
          search: debouncedSearch || undefined,
        },
        replace: true,
      });
    },
    [navigate, debouncedSearch]
  );

  // Fetch quest plans
  const {
    data: response,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<QuestPlansResponse>({
    queryKey: ['quest-plans', filterState],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterState !== 'all') {
        params.append('state', filterState);
      }
      const { data } = await api.get<QuestPlansResponse>(`/api/quest-plans?${params}`);
      return data;
    },
  });

  const plans = useMemo(() => response?.data || [], [response?.data]);

  // Use server-side stats (calculated from ALL user's plans, not just filtered)
  const stats = useMemo(
    () =>
      response?.stats || {
        active: 0,
        paused: 0,
        completed: 0,
        archived: 0,
        totalTimeSpent: 0,
      },
    [response?.stats]
  );

  // Filter plans based on search (searches goal and tags) - memoized to prevent unnecessary recalculations
  const filteredPlans = useMemo(() => {
    return plans.filter((plan: QuestPlan) => {
      if (debouncedSearch) {
        const searchLower = debouncedSearch.toLowerCase();
        const matchesGoal = plan.goal.toLowerCase().includes(searchLower);
        const matchesTags = plan.tags?.some(tag => tag.toLowerCase().includes(searchLower)) ?? false;
        if (!matchesGoal && !matchesTags) {
          return false;
        }
      }
      return true;
    });
  }, [plans, debouncedSearch]);

  // Continue quest mutation
  const continueMutation = useMutation({
    mutationFn: async ({ planId, notebookId }: { planId: string; notebookId: string }) => {
      const { data } = await api.post(`/api/quest-plans/${planId}/continue`, {
        sessionId: notebookId,
      });
      // Use the sessionId returned from the API (handles placeholder notebookIds)
      return { data, sessionId: data.sessionId || notebookId };
    },
    onSuccess: ({ sessionId }) => {
      navigate({ to: `/notebooks/$id`, params: { id: sessionId } });
    },
    onError: (error: Error) => {
      console.error('Error continuing quest:', error);
      toast.error(getErrorMessage(error, 'Failed to continue quest. Please try again.'));
    },
  });

  // Archive quest mutation
  const archiveMutation = useMutation({
    mutationFn: async (planId: string) => {
      await api.delete(`/api/quest-plans/${planId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quest-plans'], refetchType: 'active' });
      toast.success('Quest archived successfully');
      // Close modal and return focus
      setArchiveConfirmOpen(false);
      setQuestToArchive(null);
      // Don't return focus to deleted button - it won't exist
      archiveTriggerRef.current = null;
    },
    onError: (error: Error) => {
      console.error('Error archiving quest:', error);
      toast.error(getErrorMessage(error, 'Failed to archive quest. Please try again.'));
      // Close modal but return focus on error (card still exists)
      setArchiveConfirmOpen(false);
      setQuestToArchive(null);
      setTimeout(() => {
        archiveTriggerRef.current?.focus();
        archiveTriggerRef.current = null;
      }, 0);
    },
  });

  // Handle archive click - opens confirmation dialog
  const handleArchiveClick = useCallback((plan: QuestPlan, triggerElement: HTMLElement | null) => {
    archiveTriggerRef.current = triggerElement;
    setQuestToArchive(plan);
    setArchiveConfirmOpen(true);
  }, []);

  // Handle closing new quest modal with focus return
  const handleCloseNewQuestModal = useCallback(() => {
    setNewQuestModalOpen(false);
    // Return focus to trigger button after modal closes
    setTimeout(() => {
      newQuestButtonRef.current?.focus();
    }, 0);
  }, []);

  // Handle closing archive modal with focus return
  const handleCloseArchiveModal = useCallback(() => {
    setArchiveConfirmOpen(false);
    setQuestToArchive(null);
    // Return focus to the archive button that triggered the modal
    setTimeout(() => {
      archiveTriggerRef.current?.focus();
      archiveTriggerRef.current = null;
    }, 0);
  }, []);

  // Handle archive confirm
  const handleArchiveConfirm = useCallback(() => {
    if (questToArchive) {
      archiveMutation.mutate(questToArchive.id);
    }
  }, [questToArchive, archiveMutation]);

  // Toggle pause/resume mutation
  const togglePauseMutation = useMutation({
    mutationFn: async ({ planId, currentState }: { planId: string; currentState: string }) => {
      const newState = currentState === 'paused' ? 'active' : 'paused';
      await api.patch(`/api/quest-plans/${planId}`, { state: newState });
      return { newState };
    },
    onSuccess: data => {
      queryClient.invalidateQueries({ queryKey: ['quest-plans'], refetchType: 'active' });
      toast.success(data.newState === 'paused' ? 'Quest paused' : 'Quest resumed');
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Failed to update quest state'));
    },
  });

  // Mark quest complete mutation
  const markCompleteMutation = useMutation({
    mutationFn: async (planId: string) => {
      await api.patch(`/api/quest-plans/${planId}`, { state: 'completed' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quest-plans'], refetchType: 'active' });
      toast.success('Quest marked as complete!');
    },
    onError: (error: Error) => {
      toast.error(getErrorMessage(error, 'Failed to mark quest complete'));
    },
  });

  // Handle new quest creation
  const handleCreateNewQuest = () => {
    if (!newQuestGoal.trim()) {
      toast.error('Please enter a quest goal');
      return;
    }
    setNewQuestModalOpen(false);
    setNewQuestGoal('');
    // Navigate to new notebook with quest params using Tanstack Router's search property.
    // Embedding params in the URL string doesn't work with the useSearch() hook.
    navigate({
      to: '/new',
      search: {
        questmaster: 'true',
        goal: newQuestGoal.trim(),
      },
    });
  };

  const formatDuration = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const getPriorityColor = (priority?: string) => {
    switch (priority) {
      case 'critical':
        return 'danger';
      case 'high':
        return 'warning';
      case 'medium':
        return 'neutral';
      case 'low':
        return 'success';
      default:
        return 'neutral';
    }
  };

  const getStateColor = (state: string) => {
    switch (state) {
      case 'active':
        return 'success';
      case 'completed':
        return 'primary';
      case 'paused':
        return 'warning';
      case 'draft':
        return 'neutral';
      default:
        return 'neutral';
    }
  };

  if (isLoading) {
    return (
      <Box
        data-testid="quests-loading"
        sx={{ p: 3, display: 'flex', justifyContent: 'center', alignItems: 'center', height: '50vh' }}
      >
        <Typography>Loading quests...</Typography>
      </Box>
    );
  }

  if (isError) {
    return (
      <Box
        data-testid="quests-error"
        sx={{
          p: 3,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '50vh',
          gap: 2,
        }}
      >
        <Typography level="h3" color="danger">
          Failed to load quests
        </Typography>
        <Typography level="body-md" sx={{ color: 'neutral.500' }}>
          {error instanceof Error ? error.message : 'An unexpected error occurred'}
        </Typography>
        <Button
          data-testid="quests-retry-btn"
          variant="soft"
          color="primary"
          startDecorator={<RefreshIcon />}
          onClick={() => refetch()}
        >
          Try Again
        </Button>
      </Box>
    );
  }

  return (
    <Box data-testid="quests-page" sx={{ p: { xs: 1.5, sm: 2, md: 3 }, maxWidth: 1400, mx: 'auto' }}>
      {/* Header */}
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h1">My Quests</Typography>
          <ContextHelpButton helpId="features/quest-master" tooltipText="Learn about Quest Master" />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Tooltip title="Refresh quests">
            <IconButton
              data-testid="quests-refresh-btn"
              onClick={() => refetch()}
              variant="soft"
              color="neutral"
              aria-label="Refresh quests"
            >
              <RefreshIcon />
            </IconButton>
          </Tooltip>
          <Button
            ref={newQuestButtonRef}
            data-testid="quests-new-btn"
            startDecorator={<AddIcon />}
            onClick={() => setNewQuestModalOpen(true)}
          >
            New Quest
          </Button>
        </Stack>
      </Stack>

      {/* Stats Cards */}
      <Box
        component="section"
        aria-label="Quest Statistics"
        sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 2, mb: 3 }}
      >
        <Card data-testid="stats-active-quests">
          <CardContent>
            <Typography level="body-sm">Active Quests</Typography>
            <Typography level="h2">{stats.active}</Typography>
          </CardContent>
        </Card>
        <Card data-testid="stats-completed">
          <CardContent>
            <Typography level="body-sm">Completed</Typography>
            <Typography level="h2">{stats.completed}</Typography>
          </CardContent>
        </Card>
        <Card data-testid="stats-total">
          <CardContent>
            <Typography level="body-sm">Total Quests</Typography>
            <Typography level="h2">{stats.active + stats.paused + stats.completed + stats.archived}</Typography>
          </CardContent>
        </Card>
        <Card data-testid="stats-time-invested">
          <CardContent>
            <Typography level="body-sm">Time Invested</Typography>
            <Typography level="h2">{formatDuration(stats.totalTimeSpent)}</Typography>
          </CardContent>
        </Card>
      </Box>

      {/* Filters */}
      <Stack direction="row" spacing={2} sx={{ mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Input
          data-testid="quests-search-input"
          placeholder="Search quests by goal or tags..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          startDecorator={<SearchIcon />}
          sx={{ flex: 1, maxWidth: 400, minWidth: 200 }}
          aria-label="Search quests"
        />
        <Stack
          direction="row"
          spacing={1}
          role="group"
          aria-label="Filter by status"
          sx={{ overflowX: 'auto', pb: 0.5 }}
        >
          <Button
            data-testid="filter-all"
            variant={filterState === 'all' ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => setFilterState('all')}
            aria-pressed={filterState === 'all'}
          >
            All
          </Button>
          <Button
            data-testid="filter-active"
            variant={filterState === 'active' ? 'solid' : 'soft'}
            color="success"
            onClick={() => setFilterState('active')}
            aria-pressed={filterState === 'active'}
          >
            Active
          </Button>
          <Button
            data-testid="filter-paused"
            variant={filterState === 'paused' ? 'solid' : 'soft'}
            color="warning"
            onClick={() => setFilterState('paused')}
            aria-pressed={filterState === 'paused'}
          >
            Paused
          </Button>
          <Button
            data-testid="filter-completed"
            variant={filterState === 'completed' ? 'solid' : 'soft'}
            color="primary"
            onClick={() => setFilterState('completed')}
            aria-pressed={filterState === 'completed'}
          >
            Completed
          </Button>
          <Button
            data-testid="filter-archived"
            variant={filterState === 'archived' ? 'solid' : 'soft'}
            color="neutral"
            onClick={() => setFilterState('archived')}
            aria-pressed={filterState === 'archived'}
          >
            Archived
          </Button>
        </Stack>
      </Stack>

      {/* Quest Grid */}
      <ErrorBoundary
        fallback={
          <Alert color="danger" variant="soft" sx={{ m: 2 }}>
            <Typography level="title-md">Something went wrong</Typography>
            <Typography level="body-sm">
              Unable to display quest cards. Please refresh the page or try again later.
            </Typography>
            <Button size="sm" variant="soft" color="danger" onClick={() => refetch()} sx={{ mt: 1 }}>
              Try Again
            </Button>
          </Alert>
        }
      >
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(auto-fill, minmax(300px, 1fr))',
              md: 'repeat(auto-fill, minmax(350px, 1fr))',
            },
            gap: 2,
          }}
        >
          {filteredPlans.map((plan: QuestPlan) => (
            <ErrorBoundary
              key={plan.id}
              fallback={<QuestCardErrorFallback planId={plan.id} onRetry={() => refetch()} />}
            >
              <Card data-testid={`quest-card-${plan.id}`} aria-label={`Quest: ${plan.goal}`}>
                <CardContent>
                  {/* Header */}
                  <Stack direction="row" justifyContent="space-between" alignItems="start" sx={{ mb: 2 }}>
                    <Box sx={{ flex: 1, pr: 1 }}>
                      <Typography level="h3" sx={{ fontSize: '1.1rem', mb: 0.5 }}>
                        {plan.goal}
                      </Typography>
                      <Typography level="body-sm" sx={{ color: 'neutral.500' }}>
                        Last accessed {dayjs(plan.lastAccessedAt).fromNow()}
                      </Typography>
                    </Box>
                    <Stack direction="column" spacing={0.5} alignItems="flex-end">
                      <Chip size="sm" color={getStateColor(plan.state)} variant="soft">
                        {plan.state}
                      </Chip>
                      {plan.priority && (
                        <Chip size="sm" color={getPriorityColor(plan.priority)} variant="soft">
                          {plan.priority}
                        </Chip>
                      )}
                    </Stack>
                  </Stack>

                  {/* Progress */}
                  {plan.metrics && (
                    <Box sx={{ mb: 2 }}>
                      <LinearProgress
                        determinate
                        value={plan.metrics.completionRate}
                        sx={{ mb: 1 }}
                        color={plan.metrics.completionRate === 100 ? 'success' : 'primary'}
                      />
                      <Typography level="body-sm">
                        {plan.metrics.subQuestsCompleted} of {plan.metrics.subQuestsTotal} tasks complete
                        {plan.metrics.totalTimeSpent > 0 && ` • ${formatDuration(plan.metrics.totalTimeSpent)} spent`}
                      </Typography>
                    </Box>
                  )}

                  {/* Tags */}
                  {plan.tags && plan.tags.length > 0 && (
                    <Stack direction="row" spacing={0.5} sx={{ mb: 2, flexWrap: 'wrap', gap: 0.5 }}>
                      {plan.tags.map(tag => (
                        <Chip key={tag} size="sm" variant="outlined">
                          {tag}
                        </Chip>
                      ))}
                    </Stack>
                  )}
                </CardContent>

                {/* Actions */}
                <CardActions>
                  <Button
                    data-testid={`quest-continue-btn-${plan.id}`}
                    size="sm"
                    startDecorator={<PlayIcon />}
                    onClick={() => continueMutation.mutate({ planId: plan.id, notebookId: plan.notebookId })}
                    disabled={
                      (continueMutation.isPending && continueMutation.variables?.planId === plan.id) ||
                      plan.state === 'completed' ||
                      plan.state === 'archived' ||
                      plan.metrics?.completionRate === 100
                    }
                    loading={continueMutation.isPending && continueMutation.variables?.planId === plan.id}
                  >
                    Continue
                  </Button>
                  {/* Pause/Resume toggle */}
                  {plan.state !== 'completed' && plan.state !== 'archived' && plan.metrics?.completionRate !== 100 && (
                    <Tooltip title={plan.state === 'paused' ? 'Resume quest' : 'Pause quest'}>
                      <IconButton
                        data-testid={`quest-pause-btn-${plan.id}`}
                        size="sm"
                        variant="plain"
                        color={plan.state === 'paused' ? 'success' : 'warning'}
                        onClick={() => togglePauseMutation.mutate({ planId: plan.id, currentState: plan.state })}
                        disabled={togglePauseMutation.isPending && togglePauseMutation.variables?.planId === plan.id}
                        aria-label={plan.state === 'paused' ? 'Resume quest' : 'Pause quest'}
                      >
                        {plan.state === 'paused' ? <PlayIcon /> : <PauseIcon />}
                      </IconButton>
                    </Tooltip>
                  )}
                  {/* Export quest */}
                  <Tooltip title="Export quest">
                    <IconButton
                      data-testid={`quest-export-btn-${plan.id}`}
                      size="sm"
                      variant="plain"
                      color="neutral"
                      onClick={() => questExport.startExport(plan.id)}
                      disabled={questExport.isExporting || questExport.isStarting}
                      aria-label="Export quest"
                    >
                      <DownloadIcon />
                    </IconButton>
                  </Tooltip>
                  {plan.state !== 'archived' && (
                    <Tooltip title="Archive quest">
                      <IconButton
                        data-testid={`quest-archive-btn-${plan.id}`}
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={e => handleArchiveClick(plan, e.currentTarget)}
                        disabled={archiveMutation.isPending && questToArchive?.id === plan.id}
                        aria-label="Archive quest"
                      >
                        <ArchiveIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                  {plan.state !== 'completed' && plan.metrics?.completionRate === 100 && (
                    <Tooltip title="Mark quest complete">
                      <IconButton
                        data-testid={`quest-complete-btn-${plan.id}`}
                        size="sm"
                        variant="plain"
                        color="success"
                        onClick={() => markCompleteMutation.mutate(plan.id)}
                        disabled={markCompleteMutation.isPending && markCompleteMutation.variables === plan.id}
                        aria-label="Mark quest complete"
                      >
                        <CheckCircleIcon />
                      </IconButton>
                    </Tooltip>
                  )}
                </CardActions>
              </Card>
            </ErrorBoundary>
          ))}
        </Box>
      </ErrorBoundary>

      {/* Empty State */}
      {filteredPlans.length === 0 && (
        <Card data-testid="quests-empty-state" sx={{ p: 6, textAlign: 'center' }}>
          <Typography level="h3" sx={{ mb: 2 }}>
            {debouncedSearch ? 'No quests found matching your search' : 'No quests yet'}
          </Typography>
          <Typography sx={{ mb: 3 }}>
            {debouncedSearch
              ? 'Try adjusting your search terms'
              : 'Quests help you break down goals into actionable steps. Click below to create your first one!'}
          </Typography>
          {!debouncedSearch && (
            <Button
              data-testid="quests-empty-new-btn"
              size="lg"
              startDecorator={<AddIcon />}
              onClick={() => setNewQuestModalOpen(true)}
            >
              Start Your First Quest
            </Button>
          )}
        </Card>
      )}

      {/* New Quest Modal */}
      <Modal
        open={newQuestModalOpen}
        onClose={handleCloseNewQuestModal}
        disableEscapeKeyDown={false}
        disableAutoFocus={false}
        disableEnforceFocus={false}
        disableRestoreFocus={false}
      >
        <ModalDialog data-testid="new-quest-modal" sx={{ maxWidth: 500 }} aria-labelledby="new-quest-modal-title">
          <ModalClose aria-label="Close modal" />
          <Typography id="new-quest-modal-title" level="h3" sx={{ mb: 2 }}>
            Create New Quest
          </Typography>
          <Typography level="body-sm" sx={{ mb: 2 }}>
            Describe your goal and we&apos;ll break it down into actionable steps.
          </Typography>
          <FormControl sx={{ mb: 2 }}>
            <FormLabel>What do you want to accomplish?</FormLabel>
            <Textarea
              slotProps={{ textarea: { ref: newQuestGoalInputRef } }}
              data-testid="new-quest-goal-input"
              placeholder="e.g., Build a personal portfolio website with a contact form"
              minRows={3}
              value={newQuestGoal}
              onChange={e => setNewQuestGoal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleCreateNewQuest();
                }
              }}
              aria-label="Quest goal description"
            />
          </FormControl>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button
              data-testid="new-quest-cancel-btn"
              variant="plain"
              color="neutral"
              onClick={handleCloseNewQuestModal}
            >
              Cancel
            </Button>
            <Button data-testid="new-quest-submit-btn" onClick={handleCreateNewQuest} disabled={!newQuestGoal.trim()}>
              Start Quest
            </Button>
          </Stack>
        </ModalDialog>
      </Modal>

      {/* Export Progress Indicator */}
      {questExport.status !== 'idle' && (
        <Card
          data-testid="quest-export-progress"
          sx={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            width: 320,
            zIndex: 1200,
            boxShadow: 'lg',
          }}
        >
          <CardContent>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
              <Typography level="title-sm">
                {questExport.status === 'completed'
                  ? 'Export Complete'
                  : questExport.status === 'failed'
                    ? 'Export Failed'
                    : 'Exporting Quest...'}
              </Typography>
              {(questExport.status === 'completed' || questExport.status === 'failed') && (
                <IconButton size="sm" variant="plain" onClick={questExport.dismiss} aria-label="Dismiss">
                  <CloseIcon fontSize="small" />
                </IconButton>
              )}
            </Stack>
            <LinearProgress
              determinate
              value={questExport.progress}
              color={
                questExport.status === 'completed' ? 'success' : questExport.status === 'failed' ? 'danger' : 'primary'
              }
              sx={{ mb: 1 }}
            />
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {questExport.errorMessage || questExport.detail}
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Archive Confirmation Dialog */}
      <Modal
        open={archiveConfirmOpen}
        onClose={handleCloseArchiveModal}
        disableEscapeKeyDown={false}
        disableAutoFocus={false}
        disableEnforceFocus={false}
        disableRestoreFocus={false}
      >
        <ModalDialog
          data-testid="archive-confirm-modal"
          variant="outlined"
          role="alertdialog"
          aria-labelledby="archive-confirm-title"
          aria-describedby="archive-confirm-description"
        >
          <DialogTitle id="archive-confirm-title">
            <WarningIcon sx={{ mr: 1, color: 'warning.main' }} />
            Archive Quest?
          </DialogTitle>
          <Divider />
          <DialogContent id="archive-confirm-description">
            <Typography level="body-md" sx={{ mb: 1 }}>
              Are you sure you want to archive this quest?
            </Typography>
            {questToArchive && (
              <Typography
                level="body-sm"
                sx={{
                  p: 1.5,
                  bgcolor: 'background.level1',
                  borderRadius: 'sm',
                  fontStyle: 'italic',
                }}
              >
                &ldquo;{questToArchive.goal}&rdquo;
              </Typography>
            )}
            <Typography level="body-sm" sx={{ mt: 2, color: 'text.tertiary' }}>
              Archived quests can be viewed in the &ldquo;Archived&rdquo; filter but won&apos;t appear in your active
              list.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button
              ref={archiveCancelButtonRef}
              data-testid="archive-confirm-cancel-btn"
              variant="plain"
              color="neutral"
              onClick={handleCloseArchiveModal}
            >
              Cancel
            </Button>
            <Button
              data-testid="archive-confirm-btn"
              variant="solid"
              color="danger"
              onClick={handleArchiveConfirm}
              loading={archiveMutation.isPending}
            >
              Archive Quest
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </Box>
  );
}

export default QuestsPage;
