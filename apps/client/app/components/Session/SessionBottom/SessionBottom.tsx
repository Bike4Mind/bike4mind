import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerSendPrompt } from '@client/app/hooks/useChatActions';

import { Box, Typography, useTheme } from '@mui/joy';
import Grid from '@mui/joy/Grid';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';

import { useLLM } from '@client/app/contexts/LLMContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import {
  useSessions,
  useSystemPromptFiles,
  useWorkBenchActions,
  useWorkBenchFiles,
} from '@client/app/contexts/SessionsContext';
import { useEffectiveCredits } from '@client/app/hooks/useEffectiveCredits';
import { useEmbeddingMismatchStatus } from '@client/app/hooks/useEmbeddingMismatchStatus';

import HighlanderFocus from '@client/app/components/HighlanderFocus';
import VoiceDebugDrawer from '@client/app/components/Session/VoiceSessionModal/VoiceDebugDrawer';
import { SessionBottomModals } from './SessionBottomModals';
import { SessionFilePond } from './SessionFilePond';
import { SessionToolbar } from './SessionToolbar';
import { useAdvancedAISettings } from '@client/app/components/Session/AdvancedAISettings';
import { MessageFileThumbnails } from '@client/app/components/Session/MessageFileThumbnails';
import { useNotebookFilepond } from '@client/app/components/Session/NotebookFilepondProvider';
import { setKnowledgeViewer } from '@client/app/components/Knowledge/KnowledgeViewer';
import { useGetAgents, useGetSessionAgents } from '@client/app/hooks/data/agents';
import { useGetSessionQuests } from '@client/app/hooks/data/sessions';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { useShallow } from 'zustand/react/shallow';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { useIsPWA } from '@client/app/hooks/useIsPWA';
import { useMessageFiles } from '@client/app/hooks/useMessageFiles';
import useSessionLayout, {
  setSessionLayout,
  setPendingMessageFiles,
  recordModerationStatus,
  hasBlockingPendingFiles,
} from '@client/app/hooks/useSessionLayout';
import { useSubscribeChatCompletion } from '@client/app/hooks/useSubscribeChatCompletion';
import { useAutoFocus } from '@client/app/hooks/useAutoFocus';
import { useChatPaste } from '@client/app/hooks/useChatPaste';
import { useTokenLimits } from '@client/app/hooks/useTokenLimits';
import { buildSortedKnowledgeItems } from '@client/app/utils/knowledgeViewerSorting';
import { deleteFileUtility, getFabFilesFromServerByIds } from '@client/app/utils/filesAPICalls';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { LexicalChatInput, LexicalChatInputRef } from '../LexicalChatInput';
import { useModelInfo } from '../../../hooks/data/useModelInfo';
import { useAccessibleModels } from '../../../hooks/useAccessibleModels';
import { NoModelsWarning, CreditsWarning, LowCreditsWarning } from '../SessionWarnings';
import { LOW_CREDITS_THRESHOLD } from '../CreditButton';
import { useFileBrowser } from '@client/app/components/Files/Browser';
import { useMcpServerSync } from './useMcpServerSync';
import { useMessageDraft } from './useMessageDraft';
import { useSessionFiles } from './useSessionFiles';
import { useSendMessage } from './useSendMessage';
import { useRollDice } from './useRollDice';
import { useModalState } from './useModalState';
import { useVoiceState } from './useVoiceState';
import { SlashCommandSuggestions } from '@client/app/components/common/CommandSuggestions';
import { useContentTransformDetector } from '@client/app/hooks/useContentTransformDetector';

type Props = {
  /**
   * Whether to enable file attachments in the chat input
   * @default true
   */
  enableFileAttachments?: boolean;
};

const SessionBottom = forwardRef<HTMLDivElement, Props>(({ enableFileAttachments = true }, ref) => {
  const { t } = useTranslation();
  const { currentSession, currentSessionId, setCurrentSession, workBenchAgents } = useSessions();
  // While a new session is being confirmed by the server (optimistic pre-navigation),
  // pass null to all hooks that make real API calls so they don't fire against the
  // fake client-generated tmpId that doesn't exist in the database yet.
  const pendingFirstMessage = useSessionLayout(s => s.pendingFirstMessage);
  const effectiveSessionId = pendingFirstMessage ? null : currentSessionId;

  const workBenchFiles = useWorkBenchFiles(currentSessionId || undefined);
  const { setWorkBenchFiles } = useWorkBenchActions();
  const { systemFiles } = useSystemPromptFiles();
  const hasEmbeddingMismatches = useEmbeddingMismatchStatus(currentSessionId);

  // Use custom hook to fetch message files (files attached to individual messages)
  const messageFiles = useMessageFiles(effectiveSessionId);

  const totalFilesCount = workBenchFiles.length + systemFiles.length;
  const queryClient = useQueryClient();
  const theme = useTheme();
  const mode = theme.palette.mode;
  const effectiveCredits = useEffectiveCredits();

  const { chatCompletion, setChatCompletion } = useSubscribeChatCompletion(currentSessionId);

  const { readyState, subscribeToAction } = useWebsocket();

  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const lexicalInputRef = useRef<LexicalChatInputRef>(null);
  const [, setAgentBenchCollapsed] = useState<boolean>(false);
  const [filesDropdownOpen, setFilesDropdownOpen] = useState<boolean>(false);

  const [chatInputValue, setChatInputValue, setDraft, getDraft] = useChatInput(
    useShallow(s => [s.chatInputValue, s.setChatInputValue, s.setDraft, s.getDraft])
  );
  const [rephraseGlow, setRephraseGlow] = useState(false);
  const [showSlashSuggestions, setShowSlashSuggestions] = useState(false);
  const [lowCreditsWarningDismissed, setLowCreditsWarningDismissed] = useState(false);

  // Modal state: triggered modal, admin preview, format dialog, modal list
  const {
    triggeredModal,
    triggeredModalOpen,
    setTriggeredModalOpen,
    showAdminPreview,
    setShowAdminPreview,
    adminPreviewData,
    setAdminPreviewData,
    formatDialogOpen,
    setFormatDialogOpen,
    pasteContentForFormat,
    pasteSmartFileName,
    modalListPopupOpen,
    setModalListPopupOpen,
    modalListData,
  } = useModalState(currentSessionId);

  // Voice state: spoken words, voice session, debug drawer, credits, voice engine
  const {
    spokenWords,
    setSpokenWords,
    isVoiceSessionEnabled,
    debugDrawerOpen,
    setDebugDrawerOpen,
    creditsExhaustedByVoice,
    voiceEngine,
  } = useVoiceState({ currentSessionId });

  // Content Publishing Studio - Content Transform Detector
  const { transformedContent, shouldShowPreview, clearPreview } = useContentTransformDetector(currentSessionId);

  // LLM state needed for rendering (send logic reads its own slice internally)
  const model = useLLM(s => s.model);
  const max_tokens = useLLM(s => s.max_tokens);
  const sessionFilesOpen = useAdvancedAISettings(state => state.sessionFilesOpen);
  const setSessionFilesOpen = useAdvancedAISettings(state => state.setSessionFilesOpen);
  const [stream, setStream] = useState<boolean>(true);
  const { data: modelInfo } = useModelInfo();
  const { accessibleModels, isLoading: isModelsLoading } = useAccessibleModels();
  const hasModels = !!accessibleModels && accessibleModels.length > 0;

  // Keeps enabledMcpServers in sync with the database (init + stale-server cleanup)
  useMcpServerSync();

  const { contextWindowLimit, effectiveMaxOutputTokens, maxInputTokens, isOverContextWindow } = useTokenLimits({
    model,
    modelInfo,
    max_tokens,
    chatInputLength: chatInputValue.length,
  });

  const pond = useNotebookFilepond();
  const maxFileSize = useGetSettingsValue('MaxFileSize') || 100;
  const enforceCredits = !!useGetSettingsValue('enforceCredits');

  // Credit warning conditions - extracted for readability
  const creditsExhausted = effectiveCredits <= 0 || creditsExhaustedByVoice;
  const isLowCredits = effectiveCredits > 0 && effectiveCredits < LOW_CREDITS_THRESHOLD && !creditsExhaustedByVoice;
  const showCreditOverlay = enforceCredits && (creditsExhausted || (isLowCredits && !lowCreditsWarningDismissed));

  // FilePond expects the max file size as an MB string, e.g. '100MB'
  const maxFileSizeForFilePond = `${maxFileSize}MB`;
  const { files, setFiles, clearFiles } = useSessionFiles(currentSessionId);
  const isMobile = useIsMobile();
  const isPWA = useIsPWA();

  // Toggle state for file upload mode (false = message files, true = session files)
  const [isSessionFileMode, setIsSessionFileMode] = useState(false);

  // Track message-specific files pending send - now stored in session layout store
  const pendingMessageFilesRaw = useSessionLayout(s => s.pendingMessageFiles);
  const pendingMessageFiles = useMemo(() => pendingMessageFilesRaw || [], [pendingMessageFilesRaw]);
  const recentArtifacts = useSessionLayout(s => s.recentArtifacts);

  // Memoize sorted knowledge items for consistent ordering
  const sortedKnowledgeItems = useMemo(
    () => buildSortedKnowledgeItems(workBenchFiles, systemFiles, messageFiles, pendingMessageFiles, recentArtifacts),
    [workBenchFiles, systemFiles, messageFiles, pendingMessageFiles, recentArtifacts]
  );

  const isCompactLayout = useSessionLayout(s => s.layout === 'vertical' || s.layout === 'pip');

  // Determine if the stop button should be shown
  const shouldShowStopButton = useMemo(() => {
    // Show stop button if chat completion is in progress
    const isChatCompletionActive =
      !chatCompletion.completed && (chatCompletion.statusMessage || chatCompletion.quest?.status === 'running');
    return isChatCompletionActive;
  }, [chatCompletion.completed, chatCompletion.statusMessage, chatCompletion.quest?.status]);

  // Check if there are active file uploads or images still pending a content-moderation
  // scan - the Send button must stay disabled until the scan clears, otherwise
  // a still-scanning (or already-blocked) image can ship silently with the message.
  const hasActiveUploads = useMemo(() => {
    return hasBlockingPendingFiles(pendingMessageFiles);
  }, [pendingMessageFiles]);

  const { data: sessionAgents = [] } = useGetSessionAgents(effectiveSessionId);
  const { data: availableAgents = [] } = useGetAgents();

  // Get chat history for the current session
  const { data: questsData } = useGetSessionQuests(effectiveSessionId);
  const chatHistory = useMemo(() => (questsData?.pages || []).map(page => page.data).flat(), [questsData?.pages]);

  // Combine session agents and workBench agents for display
  const displayAgents = currentSessionId ? sessionAgents : workBenchAgents;

  // Prepare data for LexicalChatInput
  const lexicalAgents = availableAgents.map(agent => ({
    id: agent.id,
    name: agent.name,
    triggerWords: agent.triggerWords,
  }));

  const { rollRandomDice } = useRollDice();

  const { submitting, stoppingMessage, pendingAutoSubmitGoal, handleSendClick, handleStopMessage } = useSendMessage({
    lexicalInputRef,
    chatInputRef,
    clearFiles,
    stream,
    setChatCompletion,
    onAgentsAttached: () => setAgentBenchCollapsed(false),
  });

  // Expose handleSendClick for programmatic use (e.g., InteractiveChessBoard)
  const sendPromptCallback = useCallback(
    async (prompt: string) => {
      await handleSendClick(prompt);
    },

    [handleSendClick]
  );
  useEffect(() => {
    registerSendPrompt(sendPromptCallback);
    return () => registerSendPrompt(null);
  }, [sendPromptCallback]);

  const toggleFileUpload = () => {
    if (pond.current) {
      pond.current.browse();
    }
  };

  // Auto-focus the chat input when component mounts or session changes
  useAutoFocus(lexicalInputRef as any, { enabled: true });

  // Persists draft per session and restores it on session switch
  useMessageDraft(currentSessionId, setChatInputValue, setDraft, getDraft);

  const canAttachFiles = enableFileAttachments;

  const handlePaste = useChatPaste({
    currentSession,
    currentSessionId,
    chatHistory,
    chatInputValue,
    setChatInputValue,
    setWorkBenchFiles,
    setCurrentSession,
    queryClient,
    lexicalInputRef,
  });

  // Watch for changes to sessionAgents to show the AgentBench when agents are added/removed
  useEffect(() => {
    if (displayAgents.length > 0) {
      setAgentBenchCollapsed(false); // Show the AgentBench whenever agents are added/removed
    }
  }, [displayAgents]); // Watch both sessionAgents and workBenchAgents

  // Refresh files data when dropdown opens
  useEffect(() => {
    const invalidateQueries = async () => {
      // Invalidate system prompt files
      await queryClient.invalidateQueries({
        queryKey: ['system-prompt-files'],
        exact: false,
      });

      // Also invalidate fab files if needed
      await queryClient.invalidateQueries({
        queryKey: ['fabFiles'],
        exact: false,
      });
    };

    if (filesDropdownOpen) {
      invalidateQueries();
    }
  }, [filesDropdownOpen, currentSessionId, queryClient]);

  // Subscribe to the async upload content-moderation scan result and patch the
  // matching composer thumbnail in place via recordModerationStatus: 'blocked' flips it to
  // 'blocked' (GetFileIcon renders the blocked placeholder). On 'clean' the held fabFile
  // still only has a PUT-signed presignedUrl (fileUrl was nulled by the serve-gate while
  // scanning), so we re-fetch the fabFile here to get a fresh GET-signed fileUrl (now
  // regenerated server-side since moderationStatus passes isImageServeable) and merge it in
  // before flipping the item to 'complete' - otherwise GetFileIcon has nothing valid to
  // render. recordModerationStatus buffers the event by fabFileId when the composer hasn't
  // swapped in the real FabFile id yet (upload still resolving) - see SessionFilePond's
  // consumeBufferedModerationStatus reconciliation on that swap - so a ws event that beats
  // the id-swap doesn't strand the item on the 'scanning' placeholder forever.
  useEffect(() => {
    const unsubscribe = subscribeToAction('image_moderation_status', async msg => {
      if (msg.action !== 'image_moderation_status') return;

      if (msg.moderationStatus === 'clean') {
        let fileUrl: string | undefined;
        try {
          const [fresh] = await getFabFilesFromServerByIds([msg.fabFileId]);
          fileUrl = fresh?.fileUrl ?? undefined;
        } catch {
          // Fall through - the reducer still flips status to 'complete'; a page refresh
          // (File Manager / message stream) self-heals by refetching a valid fileUrl.
        }
        recordModerationStatus(msg.fabFileId, 'clean', fileUrl);
      } else {
        recordModerationStatus(msg.fabFileId, msg.moderationStatus);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [subscribeToAction]);

  const { setOpen: setFileBrowserOpen } = useFileBrowser();

  return (
    <Box
      ref={ref}
      className="session-bottom"
      sx={{ pb: isCompactLayout || isMobile ? '0' : '1.25rem', paddingTop: '20px', position: 'relative' }}
      display={'flex'}
      justifyContent={'center'}
    >
      <HighlanderFocus targetId="chatInput" />
      <Stack
        className="session-bottom-container"
        data-testid="session-bottom-container"
        sx={theme => ({
          width: isMobile ? '100vw' : '100%',
          maxWidth: '950px',
          marginLeft: isCompactLayout ? '0px' : 'auto',
          marginRight: isCompactLayout ? '0px' : 'auto',
          ...(isCompactLayout || isMobile
            ? {
                borderTop: '1px solid',
                borderTopColor: 'border.solid',
                borderLeft: 'none',
                borderRight: 'none',
                borderBottom: 'none',
              }
            : {
                border: '1px solid',
                borderColor: 'border.solid',
              }),
          backgroundColor: theme.palette.background.panel,
          boxShadow: theme.palette.session.boxShadow,
          paddingX: isPWA ? '24px' : '16px',
          pb: isPWA ? '20px' : isMobile ? '10px' : '0px',
          borderRadius: isCompactLayout || isMobile ? 0 : '.625rem',
        })}
      >
        <Box>
          <Grid container spacing={0} mt={'0vh'} sx={{ width: '100%', height: '100%' }} alignContent="center">
            <Grid xs={12}>
              {/* Remove settings icon and attachment button code from here since they're now inline */}

              <Box
                className="session-bottom-input-container"
                sx={{
                  display: 'flex',
                  flexDirection: 'column',
                  width: '100%',
                  paddingX: '0',
                  borderRadius: '6px',
                  marginTop: '-10px',
                  position: 'relative',
                }}
              >
                <NoModelsWarning show={!isModelsLoading && (!accessibleModels || accessibleModels.length === 0)} />
                <Stack
                  className="session-bottom-input-row"
                  direction="row"
                  spacing={2}
                  alignItems="center"
                  sx={{ position: 'relative', paddingTop: '10px' }}
                >
                  <Box
                    className="session-bottom-editor-wrapper"
                    sx={{
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                      padding: '8px 0px',
                      flex: 1,
                      overflow: 'visible',
                      position: 'relative',
                      minHeight: showCreditOverlay ? '60px' : undefined,
                      transition: 'box-shadow 300ms, outline 300ms',
                      boxShadow: rephraseGlow
                        ? '0 0 0 2px rgba(59,130,246,0.3), 0 0 12px rgba(59,130,246,0.45)'
                        : undefined,
                      outline: rephraseGlow ? '2px solid rgba(59,130,246,0.35)' : undefined,
                      borderRadius: '8px',
                    }}
                  >
                    <CreditsWarning show={creditsExhausted && enforceCredits && hasModels} />
                    <LowCreditsWarning
                      show={isLowCredits && !lowCreditsWarningDismissed && enforceCredits && hasModels}
                      currentCredits={effectiveCredits}
                      onDismiss={() => setLowCreditsWarningDismissed(true)}
                    />
                    {/* Slash command suggestions */}
                    {showSlashSuggestions && (
                      <SlashCommandSuggestions
                        input={chatInputValue}
                        onSelectSuggestion={(suggestion: string, selectionRange?: { start: number; end: number }) => {
                          setChatInputValue(suggestion);
                          setShowSlashSuggestions(false);

                          // If there's a selection range (placeholder), select it after React and Lexical update
                          if (selectionRange && lexicalInputRef.current) {
                            // Use longer timeout to ensure Lexical has fully synced the new value
                            setTimeout(() => {
                              lexicalInputRef.current?.focus();
                              lexicalInputRef.current?.setSelection(selectionRange.start, selectionRange.end);
                            }, 50);
                          } else {
                            // No selection range, just focus at the end
                            setTimeout(() => {
                              lexicalInputRef.current?.focus();
                            }, 50);
                          }
                        }}
                        onVisibilityChange={() => {}}
                      />
                    )}

                    <LexicalChatInput
                      ref={lexicalInputRef}
                      value={chatInputValue}
                      onChange={newValue => {
                        setChatInputValue(newValue);

                        // Save draft as user types
                        if (currentSessionId) {
                          setDraft(currentSessionId, newValue);
                        }

                        const shouldShowSlashSuggestions =
                          typeof newValue === 'string' &&
                          newValue.startsWith('/') &&
                          !newValue.startsWith('/admin') &&
                          !newValue.includes(' '); // Hide when user has completed the command and added a space

                        setShowSlashSuggestions(shouldShowSlashSuggestions);
                      }}
                      onSubmit={async () => {
                        // Block Enter-to-send while a response is still streaming (the toolbar
                        // shows Stop, not Send, so the button path is already gated). Without
                        // this, a second prompt sent mid-response makes the two quests' status
                        // timers fight in the progress area. See #285.
                        if (shouldShowStopButton || submitting) return;
                        await handleSendClick();
                      }}
                      onPaste={handlePaste}
                      placeholder={`${t('session.typeYourMessage')}...`}
                      agents={lexicalAgents}
                    />

                    {isOverContextWindow ? (
                      <Box
                        sx={{
                          position: 'absolute',
                          mr: 20,
                          zIndex: 2000,
                          backgroundColor: 'background.surface',
                          borderRadius: '6px',
                          padding: '4px 8px',
                        }}
                      >
                        <Tooltip title="Context Window">
                          <Typography
                            sx={theme => ({
                              color: isOverContextWindow ? 'red' : theme.palette.text.primary,
                              textAlign: 'right',
                              leadingTrim: 'both',
                              textEdge: 'cap',
                              fontSize: '14px',
                              fontStyle: 'normal',
                              fontWeight: '400',
                              lineHeight: '100%',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'flex-end',
                            })}
                            variant="plain"
                            level="body-xs"
                          >
                            <Box component="span" sx={{ fontWeight: '500' }}>
                              {chatInputValue.length}/{maxInputTokens}
                            </Box>
                            <Box component="span" sx={{ opacity: 0.7, fontSize: '12px', mt: 0.5 }}>
                              Context: {contextWindowLimit} - Output: {effectiveMaxOutputTokens}
                            </Box>
                          </Typography>
                        </Tooltip>
                      </Box>
                    ) : null}
                  </Box>
                </Stack>
              </Box>
            </Grid>
          </Grid>
        </Box>

        {canAttachFiles && (
          <SessionFilePond
            pond={pond}
            files={files}
            setFiles={setFiles}
            maxFileSizeForFilePond={maxFileSizeForFilePond}
            isSessionFileMode={isSessionFileMode}
            currentSessionId={currentSessionId}
            currentSession={currentSession}
            setWorkBenchFiles={setWorkBenchFiles}
            setCurrentSession={setCurrentSession}
            lexicalInputRef={lexicalInputRef}
            chatInputValue={chatInputValue}
            setChatInputValue={setChatInputValue}
          />
        )}

        {/* File Thumbnails */}
        {pendingMessageFiles.length > 0 && (
          <MessageFileThumbnails
            files={pendingMessageFiles}
            onRemove={fileId => {
              setPendingMessageFiles(prev => prev.filter(item => item.fabFile.id !== fileId));
              setFiles(prevFiles => prevFiles.filter(f => f.serverId !== fileId));

              // If session mode, also remove from workBenchFiles
              if (isSessionFileMode) {
                setWorkBenchFiles(currentSessionId ?? '', prev => prev.filter(f => f.id !== fileId));
                if (currentSession) {
                  const updatedKnowledgeIds = (currentSession.knowledgeIds || []).filter(id => id !== fileId);
                  setCurrentSession({ ...currentSession, knowledgeIds: updatedKnowledgeIds });
                }
              }

              // Delete FabFile from server
              deleteFileUtility(fileId).catch(err => {
                console.error('Failed to delete file:', err);
              });
            }}
            onClick={file => {
              // First ensure the KnowledgeViewer is open by setting layout to vertical
              setSessionLayout({
                layout: 'vertical',
                selectedArtifactId: undefined,
                artifactData: undefined,
              });

              // Find the message file in the sorted knowledge items list
              const messageFileIndex = sortedKnowledgeItems.findIndex(item => item.id === file.id);

              // Set the knowledge viewer to show the message file
              // setTimeout ensures the layout change completes before setting the tab index
              if (messageFileIndex !== -1) {
                setTimeout(() => {
                  setKnowledgeViewer({ selectedTabIndex: messageFileIndex });
                }, 0);
              }
            }}
          />
        )}

        <SessionToolbar
          isMobile={isMobile}
          mode={mode}
          canAttachFiles={canAttachFiles}
          workBenchFiles={workBenchFiles}
          currentSessionId={currentSessionId}
          currentSession={currentSession}
          setWorkBenchFiles={setWorkBenchFiles}
          setCurrentSession={setCurrentSession}
          toggleFileUpload={toggleFileUpload}
          setFileBrowserOpen={setFileBrowserOpen}
          rollRandomDice={rollRandomDice}
          isSessionFileMode={isSessionFileMode}
          setIsSessionFileMode={setIsSessionFileMode}
          totalFilesCount={totalFilesCount}
          hasEmbeddingMismatches={hasEmbeddingMismatches}
          model={model}
          filesDropdownOpen={filesDropdownOpen}
          setFilesDropdownOpen={setFilesDropdownOpen}
          chatInputValue={chatInputValue}
          setChatInputValue={setChatInputValue}
          setRephraseGlow={setRephraseGlow}
          stream={stream}
          setStream={setStream}
          spokenWords={spokenWords}
          setSpokenWords={setSpokenWords}
          submitting={submitting}
          stoppingMessage={stoppingMessage}
          shouldShowStopButton={shouldShowStopButton}
          handleSendClick={handleSendClick}
          handleStopMessage={handleStopMessage}
          pendingAutoSubmitGoal={pendingAutoSubmitGoal}
          readyState={readyState}
          hasActiveUploads={hasActiveUploads}
          accessibleModels={accessibleModels}
          isModelsLoading={isModelsLoading}
          isVoiceSessionEnabled={isVoiceSessionEnabled}
          voiceEngine={voiceEngine}
          creditsBlocked={creditsExhausted && enforceCredits}
          setDebugDrawerOpen={setDebugDrawerOpen}
        />
      </Stack>

      {isVoiceSessionEnabled && (
        <VoiceDebugDrawer open={debugDrawerOpen} onClose={() => setDebugDrawerOpen(false)} engine={voiceEngine} />
      )}

      <SessionBottomModals
        adminPreviewData={adminPreviewData}
        showAdminPreview={showAdminPreview}
        setShowAdminPreview={setShowAdminPreview}
        setAdminPreviewData={setAdminPreviewData}
        modalListPopupOpen={modalListPopupOpen}
        setModalListPopupOpen={setModalListPopupOpen}
        modalListData={modalListData}
        triggeredModal={triggeredModal}
        triggeredModalOpen={triggeredModalOpen}
        setTriggeredModalOpen={setTriggeredModalOpen}
        formatDialogOpen={formatDialogOpen}
        setFormatDialogOpen={setFormatDialogOpen}
        pasteContentForFormat={pasteContentForFormat}
        pasteSmartFileName={pasteSmartFileName}
        transformedContent={transformedContent}
        shouldShowPreview={shouldShowPreview}
        clearPreview={clearPreview}
        sessionFilesOpen={sessionFilesOpen}
        setSessionFilesOpen={setSessionFilesOpen}
        model={model}
      />
    </Box>
  );
});

SessionBottom.displayName = 'SessionBottom';

export default SessionBottom;
