import { IQuestMasterPlanDocument, ISessionDocument, QuestMasterData, supportedChatModels } from '@bike4mind/common';
import { handleLLMCommand } from '@client/app/components/commands/LLMCommand';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useGetQuestMasterPlan, useUpdateQuestProgress } from '@client/app/hooks/data/quests';
import {
  Check as CheckIcon,
  ExpandMore as ExpandMoreIcon,
  AutoAwesome as QuestIcon,
  Extension as SubQuestIcon,
  Assignment as TaskIcon,
  RadioButtonChecked as FocusIcon,
  Refresh as RetryIcon,
  SkipNext as SkipIcon,
  MoreVert as MoreVertIcon,
  PlayArrow as PlayArrowIcon,
  Science as ScienceIcon,
  AccountTree as AccountTreeIcon,
  CheckCircle as CheckCircleIcon,
} from '@mui/icons-material';
import {
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Divider,
  Dropdown,
  IconButton,
  ListItemDecorator,
  Menu,
  MenuButton,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { keyframes } from '@mui/system';
import { useQueryClient } from '@tanstack/react-query';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import {
  Difficulty,
  DifficultyIcons,
  getDifficultyColor,
  getTaskTypeColor,
  TaskType,
  TaskTypeIcons,
} from './types/QuestTypes';
import QuestExportMenu from './QuestExportMenu';
import { useSubscribeCollection } from '@client/app/utils/react-query';
import { SubscriptionCallbackFunction } from '@client/app/hooks/useCollection';

interface QuestMasterComponentProps {
  isInKnowledgeViewer?: boolean; // determines rendering context
  questMasterPlanId: string;
  currentSession: ISessionDocument;
}

// Keyframe animation for "YOU ARE HERE" highlight effect
const pulseAnimation = keyframes`
  0%, 100% { box-shadow: 0 0 20px rgba(255, 171, 0, 0.3); }
  50% { box-shadow: 0 0 30px rgba(255, 171, 0, 0.6); }
`;

const getStatusColor = (status: string) => {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'done':
      return 'success';
    case 'in_progress':
    case 'started':
      return 'warning';
    case 'not_started':
    case 'pending':
      return 'neutral';
    case 'skipped':
      return 'neutral';
    case 'failed':
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
};

// SubQuestCard - one sub-quest row; layout varies by status
interface SubQuestCardProps {
  subQuest: QuestMasterData['subQuests'][number];
  questId: string;
  sessionId: string;
  isYouAreHere: boolean;
  isStarting?: boolean; // Whether this task is currently being started (loading state)
  onComplete: (questId: string, subQuestId: string) => void;
  onRetry: (questId: string, subQuestId: string) => void;
  onSkip: (questId: string, subQuestId: string) => void;
  onStart: (questId: string, subQuestId: string) => void;
  onResearch: (questId: string, subQuestId: string) => void;
  onBreakDown: (questId: string, subQuestId: string) => void;
  onClickSubQuest: (chatHistoryItemId?: string) => void;
}

const SubQuestCard: React.FC<SubQuestCardProps> = React.memo(
  ({
    subQuest,
    questId,
    sessionId,
    isYouAreHere,
    isStarting = false,
    onComplete,
    onRetry,
    onSkip,
    onStart,
    onResearch,
    onBreakDown,
    onClickSubQuest,
  }) => {
    const currentStatus = subQuest.status;
    const isCompleted = currentStatus === 'completed';
    const isInProgress = currentStatus === 'in_progress';

    // Elapsed time tracking for in-progress sub-quests
    const [elapsed, setElapsed] = useState('');
    useEffect(() => {
      if (!isInProgress || !subQuest.startedAt) {
        setElapsed('');
        return;
      }
      const formatElapsedTime = () => {
        const seconds = Math.floor((Date.now() - subQuest.startedAt!) / 1000);
        return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
      };
      setElapsed(formatElapsedTime());
      const interval = setInterval(() => setElapsed(formatElapsedTime()), 1000);
      return () => clearInterval(interval);
    }, [isInProgress, subQuest.startedAt]);

    // Keyboard handler for accessibility
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (subQuest.questId) {
          onClickSubQuest(subQuest.questId);
        }
      }
    };

    return (
      <Card
        key={subQuest.id}
        id={`subquest-${subQuest.id}`}
        data-testid={`subquest-card-${subQuest.id}`}
        variant="soft"
        tabIndex={subQuest.questId ? 0 : -1}
        role={subQuest.questId ? 'button' : undefined}
        aria-label={`Sub-quest: ${subQuest.title}, Status: ${currentStatus}`}
        onClick={() => onClickSubQuest(subQuest.questId)}
        onKeyDown={handleKeyDown}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: isCompleted
            ? 'success.softBg'
            : isYouAreHere
              ? 'warning.softBg'
              : isInProgress
                ? 'warning.softBg'
                : 'background.level3',
          borderRadius: '8px',
          borderLeft: isYouAreHere ? '6px solid' : 'none',
          borderColor: 'warning.500',
          position: 'relative',
          transition: 'all 0.2s ease-in-out',
          boxShadow: isYouAreHere ? '0 0 20px rgba(255, 171, 0, 0.3)' : 'none',
          animation: isYouAreHere ? `${pulseAnimation} 2s ease-in-out infinite` : 'none',
          cursor: subQuest.questId ? 'pointer' : 'default',
          '&:hover': {
            backgroundColor: isCompleted
              ? 'success.softHoverBg'
              : isYouAreHere
                ? 'warning.softHoverBg'
                : isInProgress
                  ? 'warning.softHoverBg'
                  : 'background.level4',
            transform: 'translateY(-2px)',
          },
        }}
      >
        {/* YOU ARE HERE Badge */}
        {isYouAreHere && (
          <Chip
            size="sm"
            variant="solid"
            color="warning"
            startDecorator={<FocusIcon />}
            sx={{
              position: 'absolute',
              top: -10,
              left: 16,
              zIndex: 1,
              fontWeight: 'bold',
              fontSize: '0.75rem',
            }}
          >
            👉 YOU&apos;RE HERE
          </Chip>
        )}

        <Box
          sx={{
            p: 1.5,
            pt: isYouAreHere ? 2.5 : 1.5,
            display: 'flex',
            width: '100%',
          }}
        >
          {isInProgress ? (
            // Consistent layout: [icon] Title (flex) [spinner] [chip] [actions]
            // Matches other states where chip is on the right
            <Stack direction="row" spacing={1} alignItems="center" width="100%">
              <TaskIcon
                sx={{
                  color: 'primary.plainColor',
                  fontSize: '18px',
                  flexShrink: 0,
                }}
              />
              <Typography level="title-sm" sx={{ flex: 1 }}>
                {subQuest.title}
              </Typography>
              <CircularProgress size="sm" sx={{ flexShrink: 0 }} />
              {elapsed && (
                <Typography
                  level="body-xs"
                  data-testid={`subquest-elapsed-${subQuest.id}`}
                  sx={{ color: 'neutral.500', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                >
                  {elapsed}
                </Typography>
              )}
              <Chip
                data-testid="status-chip"
                variant="soft"
                color={getStatusColor(currentStatus)}
                size="sm"
                sx={{ flexShrink: 0 }}
              >
                {currentStatus}
              </Chip>
              <Tooltip title="Mark as complete" placement="top">
                <Button
                  data-testid={`subquest-complete-btn-${subQuest.id}`}
                  variant="solid"
                  color="success"
                  size="sm"
                  startDecorator={<CheckIcon />}
                  onClick={e => {
                    e.stopPropagation();
                    onComplete(questId, subQuest.id);
                  }}
                  aria-label="Mark as complete"
                >
                  Complete
                </Button>
              </Tooltip>
              <Tooltip title="Retry with more detail" placement="top">
                <Button
                  data-testid={`subquest-retry-btn-${subQuest.id}`}
                  variant="outlined"
                  color="warning"
                  size="sm"
                  startDecorator={<RetryIcon />}
                  onClick={e => {
                    e.stopPropagation();
                    onRetry(questId, subQuest.id);
                  }}
                  aria-label="Retry with more detail"
                >
                  Retry
                </Button>
              </Tooltip>
              <Tooltip title="Skip this task" placement="top">
                <IconButton
                  data-testid={`subquest-skip-btn-${subQuest.id}`}
                  variant="plain"
                  color="neutral"
                  size="sm"
                  onClick={e => {
                    e.stopPropagation();
                    onSkip(questId, subQuest.id);
                  }}
                  aria-label="Skip this task"
                >
                  <SkipIcon />
                </IconButton>
              </Tooltip>
            </Stack>
          ) : (
            // Single-row layout for other states (not_started, completed, skipped)
            <Stack direction="row" spacing={1} alignItems="center" width="100%">
              <TaskIcon
                sx={{
                  color: 'primary.plainColor',
                  fontSize: '18px',
                  flexShrink: 0,
                }}
              />
              <Typography level="title-sm" sx={{ flex: 1 }}>
                {subQuest.title}
              </Typography>

              <Chip data-testid="status-chip" variant="soft" color={getStatusColor(currentStatus)} size="sm">
                {currentStatus}
              </Chip>

              {!isCompleted && (
                <>
                  <Tooltip title="Start working on this task" placement="top">
                    <Button
                      data-testid={`subquest-start-btn-${subQuest.id}`}
                      variant="solid"
                      color="primary"
                      size="sm"
                      startDecorator={isStarting ? <CircularProgress size="sm" /> : <PlayArrowIcon />}
                      onClick={e => {
                        e.stopPropagation();
                        onStart(questId, subQuest.id);
                      }}
                      disabled={isStarting}
                      loading={isStarting}
                      aria-label="Start working on this task"
                    >
                      {isStarting ? 'Starting...' : 'Work on this'}
                    </Button>
                  </Tooltip>
                  <Dropdown>
                    <MenuButton
                      slots={{ root: IconButton }}
                      slotProps={{
                        root: {
                          variant: 'soft',
                          color: 'neutral',
                          size: 'sm',
                          onClick: (e: React.MouseEvent) => e.stopPropagation(),
                          'data-testid': `subquest-menu-btn-${subQuest.id}`,
                          'aria-label': 'More actions',
                        },
                      }}
                    >
                      <MoreVertIcon />
                    </MenuButton>
                    <Menu placement="bottom-end" size="sm">
                      <MenuItem
                        data-testid={`subquest-research-btn-${subQuest.id}`}
                        onClick={e => {
                          e.stopPropagation();
                          onResearch(questId, subQuest.id);
                        }}
                      >
                        <ListItemDecorator>
                          <ScienceIcon />
                        </ListItemDecorator>
                        Research
                      </MenuItem>
                      <MenuItem
                        data-testid={`subquest-breakdown-btn-${subQuest.id}`}
                        onClick={e => {
                          e.stopPropagation();
                          onBreakDown(questId, subQuest.id);
                        }}
                      >
                        <ListItemDecorator>
                          <AccountTreeIcon />
                        </ListItemDecorator>
                        Break down further
                      </MenuItem>
                      <Divider />
                      <MenuItem
                        data-testid={`subquest-markcomplete-btn-${subQuest.id}`}
                        onClick={e => {
                          e.stopPropagation();
                          onComplete(questId, subQuest.id);
                        }}
                      >
                        <ListItemDecorator>
                          <CheckCircleIcon />
                        </ListItemDecorator>
                        Mark complete
                      </MenuItem>
                    </Menu>
                  </Dropdown>
                </>
              )}
              {isCompleted && (
                <Tooltip title="Regenerate response" placement="top">
                  <Button
                    variant="outlined"
                    color="neutral"
                    size="sm"
                    startDecorator={<RetryIcon />}
                    onClick={e => {
                      e.stopPropagation();
                      onRetry(questId, subQuest.id);
                    }}
                  >
                    Retry
                  </Button>
                </Tooltip>
              )}
            </Stack>
          )}
        </Box>
      </Card>
    );
  }
);

SubQuestCard.displayName = 'SubQuestCard';

const QuestMasterReply: React.FC<QuestMasterComponentProps> = ({
  questMasterPlanId,
  isInKnowledgeViewer = false, // Default to false (chat view)
  currentSession,
}) => {
  const { currentUser } = useUser();
  const questMasterPlan = useGetQuestMasterPlan(questMasterPlanId);
  const queryClient = useQueryClient();
  const { sendJsonMessage } = useWebsocket();
  const [model, max_tokens, tools, organizationId, enabledMcpServers] = useLLM(
    useShallow(s => [s.model, s.max_tokens, s.tools, s.organizationId, s.enabledMcpServers])
  );
  const updateQuestProgress = useUpdateQuestProgress();

  // Track which task is currently being started to prevent race conditions
  const [startingTaskId, setStartingTaskId] = useState<string | null>(null);

  // Track previous data to detect status changes
  const prevDataRef = useRef<IQuestMasterPlanDocument | null>(null);

  // Track mounted state to prevent memory leaks in DOM manipulation callbacks
  const isMountedRef = useRef(true);
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Clean up any pending highlight timeout
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
    };
  }, []);

  useSubscribeCollection(
    'questmasterplans',
    useMemo(() => ({ _id: questMasterPlanId }), [questMasterPlanId]),
    useCallback<SubscriptionCallbackFunction<IQuestMasterPlanDocument>>(
      (type, data) => {
        const prevData = prevDataRef.current;

        // Detect newly completed subtasks
        if (prevData && data) {
          const prevSubQuests = prevData.quests.flatMap(q => q.subQuests);
          const newSubQuests = data.quests.flatMap(q => q.subQuests);

          for (const newSq of newSubQuests) {
            const prevSq = prevSubQuests.find(sq => sq.id === newSq.id);
            if (prevSq && prevSq.status === 'in_progress' && newSq.status === 'completed') {
              toast.success(`Subtask completed: ${newSq.title}`);
            }
          }
        }

        prevDataRef.current = data;
        queryClient.setQueryData(['quest-master-plans', questMasterPlanId], data);
      },
      [queryClient, questMasterPlanId]
    )
  );

  const [expandedQuestIds, setExpandedQuestIds] = useState<string[]>([]);

  const toggleQuestExpansion = (questId: string) => {
    setExpandedQuestIds(prev => (prev.includes(questId) ? prev.filter(id => id !== questId) : [...prev, questId]));
  };

  // Find the current/next sub-quest to work on (YOU ARE HERE logic)
  const nextSubQuest = useMemo(() => {
    const data = questMasterPlan?.data;
    if (!data) return null;

    for (const quest of data.quests) {
      // First, check if there's an in_progress sub-quest
      const inProgress = quest.subQuests.find(sq => sq.status === 'in_progress');
      if (inProgress) {
        return { quest, subQuest: inProgress, type: 'in_progress' as const };
      }
    }

    // If no in_progress, find the first not_started sub-quest
    for (const quest of data.quests) {
      const notStarted = quest.subQuests.find(sq => sq.status === 'not_started');
      if (notStarted) {
        return { quest, subQuest: notStarted, type: 'next' as const };
      }
    }

    return null;
  }, [questMasterPlan?.data]);

  const handleStartTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      // Prevent double-submission with loading state
      if (startingTaskId) {
        toast.info('A task is already being started. Please wait.');
        return;
      }

      if (!currentUser) {
        toast.error('You must be logged in to start a task');
        return;
      }

      const parsedModel = supportedChatModels.safeParse(model);
      if (!parsedModel.success) {
        toast.error('Invalid model selected. Please select a valid model.');
        return;
      }

      const mainTask = questMasterPlan?.data?.quests.find(quest => quest.id === mainTaskId);
      const subQuest = mainTask?.subQuests.find(subQuest => subQuest.id === subQuestId);
      if (!mainTask || !subQuest) {
        toast.error('Task not found. Please refresh and try again.');
        return;
      }

      setStartingTaskId(subQuestId);

      try {
        // STEP 1: optimistic in_progress update for instant feedback before the LLM call
        await updateQuestProgress.mutateAsync({
          planId: questMasterPlanId,
          questId: mainTaskId,
          subQuestId: subQuestId,
          status: 'in_progress',
          startedAt: Date.now(),
        });

        const prompt = `I am working on this task: "${mainTask.title}" - ${mainTask.description}\n\nPlease help me complete this specific subtask: "${subQuest.title}"\n\nBe thorough and detailed in your response.`;

        // STEP 2: Fire LLM command and get the created message
        const createdMessage = await handleLLMCommand({
          userId: currentUser?.id,
          questId: subQuest.questId,
          currentSession: currentSession,
          params: prompt,
          model: parsedModel.data,
          enableQuestMaster: true,
          workBenchFiles: [],
          sendJsonMessage,
          promptFileIds: [],
          queryClient: queryClient,
          tools,
          max_tokens,
          organizationId,
          questMaster: {
            questMasterPlanId,
            questId: mainTaskId,
            subQuestId: subQuestId,
          },
        });

        // STEP 3: Link the chat message ID to the sub-quest (enables polling)
        if (createdMessage) {
          await updateQuestProgress.mutateAsync({
            planId: questMasterPlanId,
            questId: mainTaskId,
            subQuestId: subQuestId,
            chatMessageId: createdMessage.quest.id,
          });

          console.log(`Linked sub-quest ${subQuestId} to message ${createdMessage.quest.id}`);
        }
      } catch (error) {
        console.error('Error starting task:', error);
        toast.error('Failed to start task. Please try again.');
      } finally {
        // Guard against unmount to avoid a React state-update warning
        if (isMountedRef.current) {
          setStartingTaskId(null);
        }
      }
    },
    [
      startingTaskId,
      currentUser,
      model,
      questMasterPlan?.data?.quests,
      questMasterPlanId,
      updateQuestProgress,
      currentSession,
      sendJsonMessage,
      queryClient,
      tools,
      max_tokens,
      organizationId,
    ]
  );

  const handleCompleteTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      // Get the sub-quest to calculate time spent
      const quest = questMasterPlan?.data?.quests.find(q => q.id === mainTaskId);
      const subQuest = quest?.subQuests.find(sq => sq.id === subQuestId);
      const startedAt = subQuest?.startedAt;

      // Calculate time spent in minutes (if we have a start time)
      const timeSpent = startedAt ? Math.round((Date.now() - startedAt) / 60000) : undefined;

      await updateQuestProgress.mutateAsync({
        planId: questMasterPlanId,
        questId: mainTaskId,
        subQuestId: subQuestId,
        status: 'completed',
        timeSpent,
      });
    },
    [questMasterPlan?.data?.quests, questMasterPlanId, updateQuestProgress]
  );

  const handleRetryTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      // Prevent double-submission
      if (startingTaskId) {
        toast.info('A task is already being processed. Please wait.');
        return;
      }

      if (!currentUser) {
        toast.error('You must be logged in to retry a task');
        return;
      }

      const parsedModel = supportedChatModels.safeParse(model);
      if (!parsedModel.success) {
        toast.error('Invalid model selected. Please select a valid model.');
        return;
      }

      const mainTask = questMasterPlan?.data?.quests.find(quest => quest.id === mainTaskId);
      const subQuest = mainTask?.subQuests.find(subQuest => subQuest.id === subQuestId);
      if (!mainTask || !subQuest) {
        toast.error('Task not found. Please refresh and try again.');
        return;
      }

      setStartingTaskId(subQuestId);

      try {
        await updateQuestProgress.mutateAsync({
          planId: questMasterPlanId,
          questId: mainTaskId,
          subQuestId: subQuestId,
          status: 'in_progress',
          startedAt: Date.now(),
        });

        const prompt = `The previous attempt did not fully complete this task. Let me try again with more detail.\n\nMain task: "${mainTask.title}" - ${mainTask.description}\n\nSub-task to retry: "${subQuest.title}"\n\nPlease provide a thorough and complete solution.`;

        await handleLLMCommand({
          userId: currentUser?.id,
          questId: subQuest.questId,
          currentSession: currentSession,
          params: prompt,
          model: parsedModel.data,
          enableQuestMaster: true,
          workBenchFiles: [],
          sendJsonMessage,
          promptFileIds: [],
          queryClient: queryClient,
          tools,
          max_tokens,
          organizationId,
          mcpServers: enabledMcpServers ?? undefined,
          questMaster: {
            questMasterPlanId,
            questId: mainTaskId,
            subQuestId: subQuestId,
          },
        });
      } catch (error) {
        console.error('Error retrying task:', error);
        toast.error('Failed to retry task. Please try again.');
      } finally {
        if (isMountedRef.current) {
          setStartingTaskId(null);
        }
      }
    },
    [
      startingTaskId,
      currentUser,
      model,
      questMasterPlan?.data?.quests,
      currentSession,
      sendJsonMessage,
      queryClient,
      tools,
      max_tokens,
      organizationId,
      enabledMcpServers,
      questMasterPlanId,
      updateQuestProgress,
    ]
  );

  const handleSkipTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      await updateQuestProgress.mutateAsync({
        planId: questMasterPlanId,
        questId: mainTaskId,
        subQuestId: subQuestId,
        status: 'skipped',
      });
    },
    [questMasterPlanId, updateQuestProgress]
  );

  const handleResearchTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      if (!currentUser) {
        toast.error('You must be logged in to research a task');
        return;
      }

      const parsedModel = supportedChatModels.safeParse(model);
      if (!parsedModel.success) {
        toast.error('Invalid model selected. Please select a valid model.');
        return;
      }

      const mainTask = questMasterPlan?.data?.quests.find(quest => quest.id === mainTaskId);
      const subQuest = mainTask?.subQuests.find(sq => sq.id === subQuestId);
      if (!mainTask || !subQuest) {
        toast.error('Task not found. Please refresh and try again.');
        return;
      }

      const prompt = `Research this topic thoroughly: "${subQuest.title}"\n\nContext: This is part of the larger goal "${mainTask.title}" - ${mainTask.description}\n\nProvide comprehensive findings with sources and detailed analysis.`;

      // Call LLM with deep research mode
      const createdMessage = await handleLLMCommand({
        userId: currentUser?.id,
        questId: subQuest.questId,
        currentSession: currentSession,
        params: prompt,
        model: parsedModel.data,
        enableQuestMaster: false, // Don't create new quest for research
        workBenchFiles: [],
        sendJsonMessage,
        promptFileIds: [],
        queryClient: queryClient,
        tools: ['deep_research'],
        max_tokens,
        organizationId,
        mcpServers: enabledMcpServers ?? undefined,
        deepResearchConfig: {
          maxDepth: 5,
          duration: 3,
        },
      });

      // Mark as in_progress with start time
      if (createdMessage) {
        await updateQuestProgress.mutateAsync({
          planId: questMasterPlanId,
          questId: mainTaskId,
          subQuestId: subQuestId,
          status: 'in_progress',
          chatMessageId: createdMessage.quest.id,
          startedAt: Date.now(),
        });
      }
    },
    [
      currentUser,
      model,
      questMasterPlan?.data?.quests,
      currentSession,
      sendJsonMessage,
      queryClient,
      max_tokens,
      organizationId,
      enabledMcpServers,
      questMasterPlanId,
      updateQuestProgress,
    ]
  );

  const handleBreakDownTask = useCallback(
    async (mainTaskId: string, subQuestId: string) => {
      if (!currentUser) {
        toast.error('You must be logged in to break down a task');
        return;
      }

      const parsedModel = supportedChatModels.safeParse(model);
      if (!parsedModel.success) {
        toast.error('Invalid model selected. Please select a valid model.');
        return;
      }

      const mainTask = questMasterPlan?.data?.quests.find(quest => quest.id === mainTaskId);
      const subQuest = mainTask?.subQuests.find(sq => sq.id === subQuestId);
      if (!mainTask || !subQuest) {
        toast.error('Task not found. Please refresh and try again.');
        return;
      }

      // Use LLM to break down the task into smaller sub-tasks
      const prompt = `Break down this task into smaller, actionable sub-tasks:\n\nTask: "${subQuest.title}"\n\nContext: This is part of the larger goal "${mainTask.title}" - ${mainTask.description}\n\nProvide a detailed breakdown with clear, specific steps that can be completed independently.`;

      try {
        await handleLLMCommand({
          userId: currentUser?.id,
          questId: subQuest.questId,
          currentSession: currentSession,
          params: prompt,
          model: parsedModel.data,
          enableQuestMaster: true, // Enable QuestMaster to create sub-tasks
          workBenchFiles: [],
          sendJsonMessage,
          promptFileIds: [],
          queryClient: queryClient,
          tools,
          max_tokens,
          organizationId,
          mcpServers: enabledMcpServers ?? undefined,
        });
      } catch (error) {
        console.error('Error breaking down task:', error);
        toast.error('Failed to break down task. Please try again.');
      }
    },
    [
      currentUser,
      model,
      questMasterPlan?.data?.quests,
      currentSession,
      sendJsonMessage,
      queryClient,
      tools,
      max_tokens,
      organizationId,
      enabledMcpServers,
    ]
  );

  const handleClickSubQuest = useCallback((chatHistoryItemId?: string) => {
    if (!chatHistoryItemId || !isMountedRef.current) return;

    // Only scroll if questId is a real message ID (MongoDB ObjectId format)
    // Skip if it's a quest ID like "quest-1", "narrative-1", or "error-quest" from initial plan creation
    // These are placeholder IDs that get replaced with real message IDs when tasks are started
    if (
      chatHistoryItemId.startsWith('quest-') ||
      chatHistoryItemId.startsWith('narrative-') ||
      chatHistoryItemId.startsWith('error-')
    ) {
      // Task hasn't been started yet - no message to scroll to
      return;
    }

    // Scroll to the chat message in the history via its data-message-id.
    // Uses DOM queries because chat messages render in a separate virtualized list
    // that doesn't share React state with QuestMasterReply.
    const messageElement = document.querySelector(`[data-message-id="${chatHistoryItemId}"]`);
    if (messageElement) {
      messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Add a temporary highlight effect using CSS animation
      messageElement.classList.add('highlight-flash');
      const handleAnimationEnd = () => {
        if (!isMountedRef.current) return;
        messageElement.classList.remove('highlight-flash');
        messageElement.removeEventListener('animationend', handleAnimationEnd);
      };
      messageElement.addEventListener('animationend', handleAnimationEnd);
      // Fallback timeout in case animation doesn't fire - store ref for cleanup
      // Clear any existing timeout first
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      highlightTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          messageElement.classList.remove('highlight-flash');
        }
        highlightTimeoutRef.current = null;
      }, 2500);
    } else {
      toast.info('Message not found in current view. It may have been scrolled out.');
    }
  }, []);

  const response = questMasterPlan?.data;

  if (!response) {
    return null;
  }

  const content = (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: isInKnowledgeViewer ? 1 : 2,
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {/* Main Header Card - Only shown in Knowledge Viewer */}
      {isInKnowledgeViewer && (
        <Card
          variant="outlined"
          sx={{
            backgroundColor: 'background.level1',
            borderRadius: '12px',
            position: 'relative',
            overflow: 'visible',
            borderWidth: 1,
            mb: 1,
          }}
        >
          <Box sx={{ p: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <Typography
                level="h2"
                sx={{
                  fontSize: '1.3rem',
                  fontWeight: 'bold',
                  color: 'primary.plainColor',
                  flex: 1,
                }}
              >
                {response?.goal}
              </Typography>
              <Chip size="sm" variant="soft" color="neutral" startDecorator={<SubQuestIcon />} sx={{ flexShrink: 0 }}>
                {response.quests.reduce((total, quest) => total + quest.subQuests.length, 0)} Steps
              </Chip>
              <QuestExportMenu planId={questMasterPlanId} plan={response} size="sm" />
            </Box>
          </Box>
        </Card>
      )}

      {/* Navigation hint - condensed */}
      {isInKnowledgeViewer && (
        <Typography level="body-sm" sx={{ px: 1, color: 'neutral.500', fontSize: '0.75rem' }}>
          Click on quests to expand/collapse and view sub-tasks.
        </Typography>
      )}

      <Box sx={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {response.quests.map((quest, _index) => {
          // Get the task type icon and color
          const taskType = TaskType.TEXT_GENERATION;
          const TaskTypeIcon = TaskTypeIcons[taskType];
          const taskTypeColor = getTaskTypeColor(taskType);

          // Get the difficulty icon and color
          const difficulty = quest.complexity.toLowerCase() as Difficulty;
          const DifficultyIcon = DifficultyIcons[difficulty];
          const difficultyColor = getDifficultyColor(difficulty);

          // Determine if this quest is expanded
          const isExpanded = isInKnowledgeViewer ? expandedQuestIds.includes(quest.id) : true;

          // Calculate quest completion percentage
          const completedSubtasks = quest.subQuests.filter(sq => sq.status === 'completed').length;

          const completionPercentage =
            quest.subQuests.length > 0 ? Math.round((completedSubtasks / quest.subQuests.length) * 100) : 0;

          return (
            <Card
              key={quest.id}
              className="questmaster-main-card"
              variant="outlined"
              sx={{
                backgroundColor: 'background.level1',
                borderRadius: '8px',
                position: 'relative',
                overflow: 'visible',
                borderWidth: 1,
                transition: 'all 0.2s ease-in-out',
                mb: 1.5,
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: 'sm',
                },
              }}
            >
              {/* Only show the quest icon badge if not in Knowledge Viewer to avoid redundancy */}
              {!isInKnowledgeViewer && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: '-12px',
                    left: '-12px',
                    backgroundColor: 'background.surface',
                    borderRadius: '50%',
                    padding: '8px',
                    boxShadow: 'sm',
                    zIndex: 1,
                  }}
                >
                  <QuestIcon color="primary" sx={{ fontSize: '24px' }} />
                </Box>
              )}

              {/* Quest Header - Acts as the expansion trigger */}
              <Box
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={`quest-content-${quest.id}`}
                sx={{
                  p: 1.5,
                  pt: !isInKnowledgeViewer ? 3 : 1.5,
                  cursor: 'pointer',
                }}
                onClick={() => toggleQuestExpansion(quest.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleQuestExpansion(quest.id);
                  }
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                  {/* Small quest icon for Knowledge Viewer mode */}
                  {isInKnowledgeViewer && <QuestIcon color="primary" sx={{ fontSize: '20px', flexShrink: 0 }} />}

                  <Typography
                    className="questmaster-quest-title"
                    level="h3"
                    sx={{
                      fontSize: '1.1rem',
                      fontWeight: 'bold',
                      color: 'text.primary',
                      flex: 1,
                    }}
                  >
                    {quest.title}
                  </Typography>

                  {/* Task Type Icon */}
                  <Tooltip title={`Task Type: ${taskType.split('_').join(' ')}`} placement="top">
                    <Chip variant="soft" color={taskTypeColor} startDecorator={<TaskTypeIcon />} size="sm">
                      {taskType
                        .split('_')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join(' ')}
                    </Chip>
                  </Tooltip>

                  {/* Difficulty Icon */}
                  <Tooltip title={`Difficulty: ${difficulty}`} placement="top">
                    <Chip variant="soft" color={difficultyColor} startDecorator={<DifficultyIcon />} size="sm">
                      {difficulty.charAt(0).toUpperCase() + difficulty.slice(1)}
                    </Chip>
                  </Tooltip>

                  {/* Completion percentage */}
                  <Tooltip title={`${completionPercentage}% Complete`} placement="top">
                    <Chip
                      variant="soft"
                      color={getStatusColor(completionPercentage === 100 ? 'completed' : 'in_progress')}
                      size="sm"
                    >
                      {completionPercentage}%
                    </Chip>
                  </Tooltip>

                  <Button
                    variant="soft"
                    color="neutral"
                    size="sm"
                    endDecorator={
                      <ExpandMoreIcon
                        sx={{
                          transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                          transition: 'transform 0.2s',
                        }}
                      />
                    }
                    sx={{
                      ml: 1,
                      minWidth: 'auto',
                      px: 1,
                    }}
                  >
                    {isExpanded ? 'Collapse' : 'Expand'}
                  </Button>
                </Box>

                {/* Quest Description - Only if it's not the same as the main goal */}
                {quest.description !== response.goal && (
                  <Box
                    sx={{
                      backgroundColor: 'background.level2',
                      p: 1.5,
                      borderRadius: '8px',
                    }}
                  >
                    <Typography level="body-md" sx={{ color: 'text.secondary' }}>
                      {quest.description}
                    </Typography>
                  </Box>
                )}
              </Box>

              {/* Sub-quests content - Show only when expanded */}
              {isExpanded && quest.subQuests.length > 0 && (
                <Box id={`quest-content-${quest.id}`} sx={{ px: 1.5, pb: 1.5, pt: 0 }}>
                  <Divider sx={{ my: 1, mb: 1.5 }}>
                    <Chip variant="soft" color="primary" startDecorator={<SubQuestIcon />} size="sm">
                      Sub Tasks
                    </Chip>
                  </Divider>

                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    {quest.subQuests.map(subQuest => (
                      <SubQuestCard
                        key={subQuest.id}
                        subQuest={subQuest}
                        questId={quest.id}
                        sessionId={currentSession.id}
                        isYouAreHere={nextSubQuest?.subQuest.id === subQuest.id}
                        isStarting={startingTaskId === subQuest.id}
                        onComplete={handleCompleteTask}
                        onRetry={handleRetryTask}
                        onSkip={handleSkipTask}
                        onStart={handleStartTask}
                        onResearch={handleResearchTask}
                        onBreakDown={handleBreakDownTask}
                        onClickSubQuest={handleClickSubQuest}
                      />
                    ))}
                  </Box>
                </Box>
              )}
            </Card>
          );
        })}
      </Box>
    </Box>
  );

  return content;
};

export default QuestMasterReply;
