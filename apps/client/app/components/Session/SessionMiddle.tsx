import NotebookSplash from '@client/app/components/Session/NotebookSplash';
import { useSessions, useWorkBenchFiles } from '@client/app/contexts/SessionsContext';
import { useUser } from '@client/app/contexts/UserContext';
import { userCanReadDoc, canShowConversation } from '@client/app/utils/userPermission';
import { GenerateImageToolCall, IChatHistoryItem, ImageModels, ISessionDocument } from '@bike4mind/common';
import { CircularProgress } from '@mui/joy';
import Box from '@mui/joy/Box';
import IconButton from '@mui/joy/IconButton';
import { useTheme } from '@mui/joy/styles';
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useGetSessionQuests } from '@client/app/hooks/data/sessions';
import { useConversationalVoiceStore } from '@client/app/components/Session/ConversationalVoice/useConversationalVoice';
import { LLMSettings, handleLLMCommand } from '../commands/LLMCommand';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useShallow } from 'zustand/react/shallow';
import { INFINITE_VALUE } from '../FibonacciSlider';
import { useAdvancedAISettings } from './AdvancedAISettings';
import { handleImageEditCommand, handleImageGenerationCommand } from '../commands/ImageGenerationCommand';
import { CommandHandlers, CommandKey, extractCommandAndParams, handleCommand } from '@client/app/utils/commands';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useSearch } from '@tanstack/react-router';
import { useChatCompletionContext } from '@client/app/contexts/ChatCompletionContext';
import { useDeleteQuest, useUpdateQuest } from '@client/app/hooks/data/quests';
import { useQueryClient } from '@tanstack/react-query';
import { SendMessageOptions } from '@client/app/utils/llm';
import { toast } from 'sonner';
import { useNotebookSearch } from '@client/app/contexts/NotebookSearchContext';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useQuestPreparation } from '@client/app/hooks/useQuestPreparation';
import KeyboardDoubleArrowDownTwoToneIcon from '@mui/icons-material/KeyboardDoubleArrowDownTwoTone';
import { useAdminTools } from '@client/app/hooks/useAdminTools';
import { useStableCallback } from '@client/app/hooks/useStableCallback';
import ChatHistory from '@client/app/components/Session/ChatHistory';
import ActiveAgentExecutions from '@client/app/components/Session/AgentExecution/ActiveAgentExecutions';
import PendingApprovalBeacon from '@client/app/components/Session/AgentExecution/PendingApprovalBeacon';
import ReplyStatus from '@client/app/components/common/ReplyStatus';
import { useUserSettings } from '@client/app/contexts/UserSettingsContext';
import Typography from '@mui/joy/Typography';
import { dispatchUiSideEffects } from '@client/app/utils/uiSideEffectDispatcher';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { useVirtuosoPagination } from './hooks/useVirtuosoPagination';
import { useStreamingMessageMerge } from './hooks/useStreamingMessageMerge';

interface IProps {
  isFullWidth?: boolean;
  sessionId: string;
}

// Separate component for scroll button to prevent parent re-renders.
// Uses the scroller DOM element directly so it scrolls to the absolute bottom
// of the scroll container - including Footer content (streaming messages).
const ScrollToBottomButton = memo(
  ({ isAtBottom, scrollerRef }: { isAtBottom: boolean; scrollerRef: React.RefObject<HTMLElement | null> }) => {
    if (isAtBottom) return null;

    return (
      <Box
        sx={{
          position: 'absolute',
          bottom: 0,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 1100,
          pointerEvents: 'none',
          boxShadow: 'none',
        }}
      >
        <IconButton
          size="sm"
          variant="outlined"
          sx={{
            backgroundColor: 'background.body',
            animation: 'bounce 4s ease-in-out infinite',
            '&:hover': {
              animation: 'none',
              backgroundColor: 'background.body',
              backgroundImage: theme =>
                `linear-gradient(${theme.palette.session.hoverBackground}, ${theme.palette.session.hoverBackground})`,
            },
            transition: 'transform 0.2s, background-color 0.2s, background-image 0.2s',
            pointerEvents: 'auto',
            boxShadow: (theme: { palette: { session: { shadowSoft: string } } }) => theme.palette.session.shadowSoft,
          }}
          onClick={() => {
            const scroller = scrollerRef.current;
            if (scroller) {
              scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
            }
          }}
        >
          <KeyboardDoubleArrowDownTwoToneIcon />
        </IconButton>
      </Box>
    );
  }
);

ScrollToBottomButton.displayName = 'ScrollToBottomButton';

const commandHandlers: CommandHandlers = {
  '/llm': handleLLMCommand,
  '/gen_image': handleImageGenerationCommand,
  '/edit_image': handleImageEditCommand,
};

const SessionMiddle: React.FC<IProps> = ({ isFullWidth = false, sessionId }) => {
  const queryClient = useQueryClient();
  const deleteQuest = useDeleteQuest(queryClient);
  const updateQuest = useUpdateQuest(queryClient);
  const { projectId } = useSearch({ strict: false });
  const { currentSession } = useSessions();
  const workBenchFiles = useWorkBenchFiles(sessionId);
  const { data: quests, fetchNextPage, isFetching, hasNextPage } = useGetSessionQuests(sessionId);
  const theme = useTheme();
  const mode = theme.palette.mode;
  const { settings } = useUserSettings();
  const { chatCompletion, setChatCompletion } = useChatCompletionContext();
  const { search, showPinnedOnly } = useNotebookSearch();
  const isMobile = useIsMobile();
  const { currentUser } = useUser();
  const canRead = userCanReadDoc(currentUser, currentSession as ISessionDocument);
  const { canUseAdminTools } = useAdminTools();
  const { clearPreparingQuest, isPreparingQuest } = useQuestPreparation();

  const [
    model,
    temperature,
    top_p,
    n,
    max_tokens,
    size,
    quality,
    style,
    safety_tolerance,
    prompt_upsampling,
    seed,
    output_format,
    isQuestMasterEnabled,
    isMementosEnabled,
    isArtifactsEnabled,
    tools,
    organizationId,
    thinking,
    enabledMcpServers,
    imageModel,
  ] = useLLM(
    useShallow(s => [
      s.model,
      s.temperature,
      s.top_p,
      s.n,
      s.max_tokens,
      s.size,
      s.quality,
      s.style,
      s.safety_tolerance,
      s.prompt_upsampling,
      s.seed,
      s.output_format,
      s.isQuestMasterEnabled,
      s.isMementosEnabled,
      s.isArtifactsEnabled,
      s.tools,
      s.organizationId,
      s.thinking,
      s.enabledMcpServers,
      s.imageModel,
    ])
  );

  // Ensure max_tokens is never undefined
  const safeMaxTokens = max_tokens ?? 2048;
  const flattenQuests = useMemo(() => {
    const all = (quests?.pages || []).map(page => page.data).flat();
    // Deduplicate by ID - pagination can produce overlapping pages when new quests are added
    const seen = new Set<string>();
    return all.filter(q => {
      if (!q.id || seen.has(q.id)) return false;
      seen.add(q.id);
      return true;
    });
  }, [quests?.pages]);

  // Clear the quest preparation overlay when quests data appears, so it stays
  // visible until the user can actually see their prompt in the chat.
  useEffect(() => {
    if (isPreparingQuest && flattenQuests.length > 0) {
      clearPreparingQuest();
    }
  }, [isPreparingQuest, flattenQuests.length, clearPreparingQuest]);

  // Scan loaded quests for uiSideEffects and dispatch them. Handles the
  // notebook-switch case where quests load from the API - the rendering-based
  // UiSideEffectDispatcher in PromptReplies has timing issues during pagination
  // loading. Tracking dispatched quest IDs prevents duplicate dispatches.
  const dispatchedQuestIds = useRef(new Set<string>());
  useEffect(() => {
    // Reset tracking when session changes
    dispatchedQuestIds.current.clear();
  }, [sessionId]);

  useEffect(() => {
    // Find the most recent completed quest with uiSideEffects
    for (const quest of flattenQuests) {
      if (
        quest.id &&
        quest.status === 'done' &&
        quest.uiSideEffects &&
        quest.uiSideEffects.length > 0 &&
        !dispatchedQuestIds.current.has(quest.id)
      ) {
        dispatchedQuestIds.current.add(quest.id);
        // Replay path (no `live` flag): this scans persisted quests as a session
        // loads, so it must stay NON-destructive - surface the "Load Problem" review
        // banner rather than auto-applying, which would clobber a brief the user
        // hand-edited after the AI first formulated it. The live auto-apply path is
        // PromptReplies / useSubscribeChatCompletion.
        dispatchUiSideEffects(quest.uiSideEffects);
        break; // Only dispatch the most recent one
      }
    }
  }, [flattenQuests]);

  const [historyLines] = useState<number>(INFINITE_VALUE);
  const liveAI = useAdvancedAISettings(state => state.liveAI);
  const { sendJsonMessage } = useWebsocket();

  // useCallback is not enough here as it won't work when calling react query hooks
  // Using only useCallback will cause ChatHistory component to rerender every time chatCompletion is being streamed
  const onDelete = useStableCallback(async (messageData: IChatHistoryItem) => {
    if (!messageData?.id) return;
    deleteQuest.mutate({ sessionId: messageData.sessionId, id: messageData.id });
  });

  // useCallback is not enough here as it won't work when calling react query hooks
  // Using only useCallback will cause ChatHistory component to rerender every time chatCompletion is being streamed
  const handlePinToggle = useStableCallback(async (messageData: IChatHistoryItem) => {
    if (!messageData.id) return;
    const newPinnedState = !messageData.pinned;

    updateQuest.mutate({
      sessionId: messageData.sessionId,
      id: messageData.id,
      update: { pinned: newPinnedState },
    });
    toast.success(newPinnedState ? 'Quest pinned!' : 'Quest unpinned!');
  });

  // useStableCallback keeps a stable reference across renders so ChatHistory's memo isn't broken.
  // (Same pattern as onDelete / handlePinToggle - useCallback's 20-item dep list was the main
  // reason ChatHistory re-rendered on every streaming chunk.)
  const sendMessage = useStableCallback(
    async (messageData: Partial<IChatHistoryItem>, options: SendMessageOptions = { isRetry: false }) => {
      const { isRetry, isImageEdit, isVariation } = options;
      if (!sessionId) return;
      if (!messageData.prompt) return;
      if (isRetry && !messageData.id) return;

      const llmSettings: LLMSettings = {
        temperature: temperature ?? 0.7,
        top_p: top_p ?? 1,
        n: n ?? 1,
        stream: true,
        stop: null,
        max_tokens: safeMaxTokens,
        presence_penalty: 0,
        frequency_penalty: 0,
        logit_bias: {},
      };
      const imageEditModel = ImageModels.FLUX_PRO_FILL;

      const imageConfig: GenerateImageToolCall = {
        model: imageModel as any,
        editModel: imageEditModel, // Model to use for image editing (separate from generation)
        size,
        quality,
        style,
        safety_tolerance,
        prompt_upsampling,
        seed,
        output_format,
      };

      const enabledFiles = workBenchFiles.map(file => file.fileName);
      const [command, params] = extractCommandAndParams(
        liveAI,
        model,
        historyLines,
        messageData?.prompt,
        enabledFiles,
        isImageEdit
      );
      const userId = currentUser!.id;

      if (commandHandlers[command as CommandKey]) {
        if (!currentSession) return;

        const promptFileIds = messageData?.fabFileIds || ([] as string[]);
        handleCommand(commandHandlers, {
          userId,
          command,
          params,
          currentSession,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          model: model as any,
          workBenchFiles,
          sendJsonMessage,
          promptFileIds,
          enableQuestMaster: isQuestMasterEnabled,
          enableMementos: isMementosEnabled,
          enableArtifacts: isArtifactsEnabled,
          questId: isVariation ? undefined : messageData?.id,
          image: options?.image,
          queryClient,
          tools,
          projectId,
          organizationId,
          thinking,
          setChatCompletion,
          ...llmSettings,
          imageConfig: imageConfig,
          mcpServers: enabledMcpServers ?? undefined,
        });
      }
    }
  );

  // Merge live WebSocket streaming data with the paginated quest cache and recover
  // stale/stalled 'running' quests. Owns streamingMessageData, activeStreamingQuestId,
  // showOptimisticSpinner, the streaming safety-valve effects, and isStreaming.
  const { streamingMessageData, activeStreamingQuestId, showOptimisticSpinner, isStreaming } = useStreamingMessageMerge(
    {
      sessionId,
      flattenQuests,
      chatCompletion,
      setChatCompletion,
    }
  );

  // Live Voice v2 call state - shown in the footer as a quiet "...Listening"
  // line (no spinner, no timer) while a call is connected and the agent is
  // waiting for input (not speaking).
  const voicePhase = useConversationalVoiceStore(s => s.phase);
  const voiceMode = useConversationalVoiceStore(s => s.mode);

  // Filter chat history based on the search term and pinned filter.
  // The streaming quest stays in the array (replaced with merged streaming data)
  // so the same MessageContent instance persists across the streaming -> completed
  // transition - no DOM remount, no flicker.
  const filteredChatHistory = useMemo(() => {
    let filtered = flattenQuests;

    // Replace the streaming quest with merged streaming data (has latest replies
    // from WebSocket) instead of filtering it out. This keeps the MessageContent
    // instance stable across the streaming -> completed handoff.
    if (activeStreamingQuestId && streamingMessageData) {
      filtered = filtered.map(q => (q.id === activeStreamingQuestId ? streamingMessageData : q));
    }

    // Filter out only truly broken quests (null, undefined, or completely empty)
    // Keep temporary optimistic quests that have valid prompts
    // Include voice session transcripts in the chat history display (even with empty prompts)
    filtered = filtered.filter(
      message =>
        message &&
        // Check if it's a voice transcript (has conversationItemId OR is voice_transcript type)
        (!!message.conversationItemId ||
          message.type === 'voice_transcript' ||
          // For other messages, require valid prompts
          (message.prompt !== null && message.prompt !== undefined && typeof message.prompt === 'string'))
    );

    // Apply pinned filter first
    if (showPinnedOnly) {
      filtered = filtered.filter(message => message.pinned === true);
    }

    // Apply search filter
    if (search.trim()) {
      const lowCaseSearch = search.toLowerCase();
      filtered = filtered.filter(
        message =>
          message.prompt.toLowerCase().includes(lowCaseSearch) ||
          (message?.replies ?? []).some(r => r.toLowerCase().includes(lowCaseSearch))
      );
    }

    return filtered;
  }, [flattenQuests, search, showPinnedOnly, activeStreamingQuestId, streamingMessageData]);

  // Clear the pending-first-message overlay once real data is available.
  // SessionMiddle is mounted underneath PendingFirstMessage immediately so it can
  // pre-fetch data. When flattenQuests has content or streaming has started, the
  // overlay is safe to remove without a blank-content flash.
  const pendingFirstMessage = useSessionLayout(s => s.pendingFirstMessage);
  useEffect(() => {
    if (!pendingFirstMessage) return;
    if (flattenQuests.length > 0 || chatCompletion.quest?.id) {
      setSessionLayout({ pendingFirstMessage: null });
    }
  }, [pendingFirstMessage, flattenQuests.length, chatCompletion.quest?.id]);
  // Safety valve: if data never arrives (e.g. server error), clear the overlay
  // after 8 seconds so the user isn't stuck.
  useEffect(() => {
    if (!pendingFirstMessage) return;
    const timer = setTimeout(() => setSessionLayout({ pendingFirstMessage: null }), 8000);
    return () => clearTimeout(timer);
  }, [pendingFirstMessage]);

  // Auto-scroll must engage the moment a quest becomes active at the bottom -
  // including the optimistic "preparing" window where the quest is `running` but
  // streaming hasn't started. In that window `streamingMessageData` is still null
  // (chatCompletion.quest still points at the previously completed quest), so
  // `isStreaming` alone is false and the view would sit on old history until the
  // first WebSocket chunk arrives - that was the perceived delay, and why the
  // "Running..." loading indicator was never scrolled into view.
  const hasActiveQuest = isStreaming || showOptimisticSpinner;
  const {
    virtuosoRef,
    firstItemIndex,
    isAtBottom,
    setIsAtBottom,
    scrollerElementRef,
    handleScrollerRef,
    handleStartReached,
  } = useVirtuosoPagination({
    sessionId,
    filteredChatHistory,
    hasNextPage: !!hasNextPage,
    fetchNextPage,
    isActive: hasActiveQuest,
  });

  return (
    <>
      <Box
        className="session-middle-container"
        sx={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          width: '100%',
          flex: 1,
          minHeight: 0,
          paddingX: isMobile ? '16px' : '0px',
        }}
      >
        <Box
          className="session-middle-wrapper"
          sx={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-start',
            width: '100%',
            flex: 1,
            minHeight: 0,
            position: 'relative',
          }}
        >
          <ScrollToBottomButton isAtBottom={isAtBottom} scrollerRef={scrollerElementRef} />
          {/* Surfaces a pending agent permission request at the bottom (the inline PermissionCard
              can scroll far out of view in a long/streaming transcript). */}
          <PendingApprovalBeacon sessionId={sessionId} scrollerRef={scrollerElementRef} />
          {/* Paint on read-gated /chat content without waiting on canRead's metadata fetch */}
          {!canShowConversation(canRead, flattenQuests.length > 0) ? (
            <NotebookSplash />
          ) : (
            <ChatHistory
              filteredChatHistory={filteredChatHistory}
              sessionId={sessionId}
              mode={mode}
              activeStreamingQuestId={activeStreamingQuestId}
              chatCompletion={chatCompletion}
              onDelete={onDelete}
              onPinToggle={handlePinToggle}
              onSendMessage={sendMessage}
              search={search}
              model={model}
              canUseAdminTools={canUseAdminTools}
              virtuosoRef={virtuosoRef}
              firstItemIndex={firstItemIndex}
              onStartReached={handleStartReached}
              onAtBottomStateChange={setIsAtBottom}
              scrollbarWidth={settings.scrollbarWidth}
              contentMaxWidth={isFullWidth ? undefined : '950px'}
              scrollerRef={handleScrollerRef}
              footer={
                <>
                  {/* Active agent executions — render the live iteration stream
                      + permission card immediately under the last chat bubble
                      so the user's eye follows the conversation naturally.
                      Previously this lived in a fixed block above SessionBottom,
                      which created a large visual gap between the user prompt
                      (top) and the agent activity (bottom of viewport).
                      Constrain to the same 950px column the chat bubbles and
                      input box use — `width: 100%` matters here because the
                      footer slot in ChatHistory passes its full container to
                      us; without it, `maxWidth: 950px` alone would let the
                      flex children collapse to their natural width and the
                      Stop button would slide to the middle of the column. */}
                  <Box
                    sx={{
                      width: '100%',
                      maxWidth: isFullWidth ? undefined : '950px',
                      marginX: 'auto',
                    }}
                  >
                    <ActiveAgentExecutions sessionId={sessionId} />
                  </Box>
                  {/* Optimistic spinner — shown when a 'running' quest is visible in
                      ChatHistory but StreamingMessage hasn't taken over yet */}
                  {showOptimisticSpinner && (
                    <Box
                      data-testid="optimistic-loading-status"
                      sx={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        width: '100%',
                        justifyContent: 'center',
                        mt: 2,
                        mb: 1,
                      }}
                    >
                      <ReplyStatus renderSpinnerStatusNull={false} status="Running..." />
                    </Box>
                  )}
                  {/* Streaming status — ReplyStatus spinner and rapid reply content.
                      The streaming quest's MessageContent is in the data array (not here)
                      to avoid DOM remount flicker on streaming completion. */}
                  {streamingMessageData && (
                    <Box sx={{ flexShrink: 0, mt: 0 }}>
                      <Box
                        data-testid="ai-loading-status"
                        sx={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          width: '100%',
                          justifyContent: 'center',
                          mt: 2,
                          mb: 1,
                        }}
                      >
                        <ReplyStatus
                          renderSpinnerStatusNull={false}
                          // Keep the spinner + elapsed timer visible for the whole run, not just
                          // before the first reply token - long silent tool calls otherwise leave
                          // a blank screen for minutes after the intro text streams in.
                          status={
                            chatCompletion.statusMessage ||
                            (streamingMessageData.status === 'running' ? 'Running...' : null)
                          }
                          createdAt={streamingMessageData.timestamp}
                          userMessage={
                            voicePhase === 'connected' && !streamingMessageData.replies?.length
                              ? streamingMessageData.prompt
                              : undefined
                          }
                        />
                      </Box>
                      {chatCompletion?.rapidReply &&
                        chatCompletion.rapidReply.status !== 'replaced' &&
                        chatCompletion?.statusMessage && (
                          <>
                            <Box
                              className="rapid-reply-container"
                              data-testid="rapid-reply-container"
                              sx={{
                                display: 'flex',
                                flexDirection: 'column',
                                width: '100%',
                                mt: 2,
                                mb: 1,
                                p: 2,
                                backgroundColor: 'chatbox.replyBg',
                                borderRadius: '8px',
                                position: 'relative',
                              }}
                            >
                              <Typography
                                level="body-md"
                                sx={{
                                  color: 'text.primary',
                                  whiteSpace: 'pre-wrap',
                                  lineHeight: 1.5,
                                  '& p:last-child': { mb: '0 !important' },
                                }}
                              >
                                {chatCompletion.rapidReply.content}
                              </Typography>
                            </Box>
                            <ReplyStatus renderSpinnerStatusNull={false} status={null} />
                          </>
                        )}
                    </Box>
                  )}
                  {/* Live voice-call status — a quiet "…Listening" line while a Voice v2
                      call is connected, the agent isn't speaking, and no quest is streaming. */}
                  {voicePhase === 'connected' && !streamingMessageData && !showOptimisticSpinner && (
                    <Box
                      data-testid="voice-call-status"
                      sx={{
                        display: 'flex',
                        alignItems: 'center',
                        width: '100%',
                        justifyContent: 'center',
                        mt: 2,
                        mb: 1,
                      }}
                    >
                      <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
                        {voiceMode !== 'speaking' && 'Listening...'}
                      </Typography>
                    </Box>
                  )}
                  {/* Loading spinner */}
                  {filteredChatHistory.length === 0 && isFetching && !streamingMessageData && (
                    <Box className="loading-indicator" sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
                      <CircularProgress />
                    </Box>
                  )}
                </>
              }
            />
          )}
        </Box>
      </Box>
    </>
  );
};

export default SessionMiddle;
