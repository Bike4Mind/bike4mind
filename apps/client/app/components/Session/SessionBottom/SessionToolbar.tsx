import React, { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Box, CircularProgress, Dropdown, IconButton, Menu, MenuButton } from '@mui/joy';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import { StopCircleSharp, Close, Check } from '@mui/icons-material';
import SendIcon from '@mui/icons-material/Send';
import { useTranslation } from 'react-i18next';

import { IFabFileDocument, ISessionDocument } from '@bike4mind/common';
import { ReadyState } from '@client/app/contexts/WebsocketContext';
import { api } from '@client/app/contexts/ApiContext';
import { fixedIconSize } from './sessionBottomConstants';
import { sessionTheme } from '@client/app/utils/themes/components/session';
import { brand, red } from '@client/app/utils/themes/colors';

import AttachFileButton from '@client/app/components/Session/AttachFileButton';
import FilesSection from '@client/app/components/Session/AISettings/FilesSection';
import AdvancedAISettings from '@client/app/components/Session/AdvancedAISettings';
import RephraseButton from '@client/app/components/Session/RephraseButton';
import AgentModeToggleButton from '@client/app/components/Session/SessionBottom/AgentModeToggleButton';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import VoiceRecordButton, { VoiceRecordButtonRef } from '@client/app/components/common/VoiceRecordButton';
import VoiceInlineButton, {
  VoiceControlsStrip,
  VOICE_DEBUG_STATE,
} from '@client/app/components/Session/VoiceSessionModal/VoiceInlineIndicator';
import ConversationalVoiceButton from '@client/app/components/Session/ConversationalVoice/ConversationalVoiceButton';
import FileViewerIcon from '../../svgs/icons/FileViewerIcon';

interface SessionToolbarProps {
  // Layout
  isMobile: boolean;
  mode: 'dark' | 'light';

  // File attach
  canAttachFiles: boolean;
  workBenchFiles: IFabFileDocument[];
  currentSessionId: string | null;
  currentSession: ISessionDocument | null;
  setWorkBenchFiles: (
    sessionId: string,
    files: IFabFileDocument[] | ((prev: IFabFileDocument[]) => IFabFileDocument[])
  ) => void;
  setCurrentSession: (session: ISessionDocument) => void;
  toggleFileUpload: () => void;
  setFileBrowserOpen: (open: boolean) => void;
  rollRandomDice: () => Promise<void>;
  isSessionFileMode: boolean;
  setIsSessionFileMode: (mode: boolean) => void;
  totalFilesCount: number;
  hasEmbeddingMismatches: boolean;
  model: string;

  // Files dropdown
  filesDropdownOpen: boolean;
  setFilesDropdownOpen: (open: boolean) => void;

  // Chat input
  chatInputValue: string;
  setChatInputValue: (value: string) => void;
  setRephraseGlow: (glow: boolean) => void;

  // AI settings
  stream: boolean;
  setStream: (stream: boolean) => void;
  spokenWords: number;
  setSpokenWords: (words: number) => void;

  // Send / Stop
  submitting: boolean;
  stoppingMessage: boolean;
  shouldShowStopButton: boolean | string;
  handleSendClick: (prompt?: string) => Promise<unknown>;
  handleStopMessage: () => Promise<void>;
  pendingAutoSubmitGoal: string | null;
  readyState: ReadyState;
  hasActiveUploads: boolean;
  accessibleModels: { id: string }[] | undefined;

  // Models loading
  isModelsLoading: boolean;

  // Voice
  isVoiceSessionEnabled: boolean | string | number | undefined;
  voiceEngine: any;
  creditsBlocked: boolean;
  setDebugDrawerOpen: (open: boolean) => void;
}

export function SessionToolbar(props: SessionToolbarProps) {
  const { t } = useTranslation();
  const {
    isMobile,
    mode,
    canAttachFiles,
    workBenchFiles,
    currentSessionId,
    currentSession,
    setWorkBenchFiles,
    setCurrentSession,
    toggleFileUpload,
    setFileBrowserOpen,
    rollRandomDice,
    isSessionFileMode,
    setIsSessionFileMode,
    totalFilesCount,
    hasEmbeddingMismatches,
    model,
    filesDropdownOpen,
    setFilesDropdownOpen,
    chatInputValue,
    setChatInputValue,
    setRephraseGlow,
    stream,
    setStream,
    spokenWords,
    setSpokenWords,
    submitting,
    stoppingMessage,
    shouldShowStopButton,
    handleSendClick,
    handleStopMessage,
    pendingAutoSubmitGoal,
    readyState,
    hasActiveUploads,
    accessibleModels,
    isModelsLoading,
    isVoiceSessionEnabled,
    voiceEngine,
    creditsBlocked,
    setDebugDrawerOpen,
  } = props;

  // Toolbar-local state
  const filesMenuRef = useRef<HTMLDivElement>(null);
  const voiceRecordRef = useRef<VoiceRecordButtonRef>(null);
  const [recording, setRecording] = useState(false);
  const [isSettingsExiting] = useState(false);

  // Layer-1 admin gate via `useFeatureEnabled('agentMode')` - honors the
  // EnableAgentMode / EnableAgentModeDefault admin settings, not just the raw
  // per-user pref, so the org-wide kill switch and admin default both reach the
  // composer. When false, the toggle button renders nothing - non-gated users
  // see zero change to the composer surface.
  const { isFeatureEnabled } = useFeatureEnabled();
  const agentModeFeatureEnabled = isFeatureEnabled('agentMode');

  return (
    <Stack className="session-bottom-toolbar" direction="column" spacing={0} alignItems="center" sx={{ width: '100%' }}>
      <Box
        sx={{
          width: '100%',
          position: 'relative',
          overflow: 'visible',
          maxHeight: isSettingsExiting ? '0px' : '500px',
          opacity: isSettingsExiting ? 0 : 1,
          transition: 'max-height 300ms ease-out, opacity 280ms ease-out',
          py: '8px',
        }}
      >
        <Box className="session-bottom-actions-row" sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
          <Box
            className="session-bottom-actions-inner"
            sx={{
              width: '100%',
            }}
          >
            <Box
              className="session-bottom-actions"
              sx={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: isMobile ? '12px' : '10px',
              }}
            >
              {canAttachFiles && (
                <AttachFileButton
                  onUploadFromComputer={toggleFileUpload}
                  onAddFromGoogleDrive={fabFile => {
                    const newWorkBenchFiles = [...workBenchFiles, fabFile];
                    setWorkBenchFiles(currentSessionId ?? '', newWorkBenchFiles);
                    if (currentSession) {
                      const knowledgeIds = newWorkBenchFiles.map(f => f.id);
                      setCurrentSession({ ...currentSession, knowledgeIds });
                    }
                  }}
                  onAddFromFileBrowser={() => setFileBrowserOpen(true)}
                  isSessionFileMode={isSessionFileMode}
                  onToggleFileMode={setIsSessionFileMode}
                  totalFilesCount={totalFilesCount}
                  chatInputValue={chatInputValue}
                  onOptimizePrompt={async () => {
                    if (!chatInputValue?.trim()) return;
                    try {
                      const response = await api.post('/api/ai/optimize-input', {
                        text: chatInputValue,
                        style: 'optimized',
                        maxLength: Math.min(chatInputValue.length * 2, 1000),
                      });
                      if (response.data?.optimizedText) {
                        setChatInputValue(response.data.optimizedText);
                        setRephraseGlow(true);
                        setTimeout(() => setRephraseGlow(false), 900);
                        toast.success('Input optimized');
                      }
                    } catch (error) {
                      console.error('Failed to optimize input:', error);
                      toast.error('Failed to optimize input');
                    }
                  }}
                />
              )}

              {!isMobile && totalFilesCount > 0 && (
                <Dropdown
                  open={filesDropdownOpen}
                  onOpenChange={(_, isOpen) => {
                    setFilesDropdownOpen(isOpen);
                    if (isOpen) {
                      setTimeout(() => {
                        filesMenuRef.current?.focus();
                      }, 100);
                    }
                  }}
                >
                  <Tooltip title="Session Files" placement="top">
                    <MenuButton
                      variant="outlined"
                      sx={{
                        display: 'flex',
                        borderRadius: '6px',
                        p: 0,
                        ...fixedIconSize,
                      }}
                      data-testid="session-files-btn"
                    >
                      <Box
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '100%',
                          height: '100%',
                          p: 0,
                        }}
                      >
                        <FileViewerIcon
                          fill={sessionTheme[mode === 'dark' ? 'dark' : 'light'].iconFill}
                          width={14}
                          height={14}
                          style={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                          }}
                        />
                        <Box
                          sx={{
                            position: 'absolute',
                            top: -6,
                            right: -6,
                            backgroundColor: hasEmbeddingMismatches ? red[400] : brand[800],
                            color: 'white',
                            borderRadius: '50%',
                            width: '20px',
                            height: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '11px',
                            fontWeight: 'bold',
                            minWidth: '20px',
                          }}
                        >
                          {totalFilesCount}
                        </Box>
                      </Box>
                    </MenuButton>
                  </Tooltip>
                  <Menu
                    ref={filesMenuRef}
                    placement="top-end"
                    autoFocus
                    sx={{
                      zIndex: 1400,
                      minWidth: '400px',
                      maxHeight: '400px',
                      overflow: 'auto',
                      '--List-padding': '0px',
                      backgroundColor: 'background.panel',
                      position: 'relative',
                    }}
                  >
                    <Box
                      sx={{
                        position: 'sticky',
                        top: 0,
                        display: 'flex',
                        justifyContent: 'flex-end',
                        pt: 1,
                        px: 1,
                        zIndex: 10,
                      }}
                    >
                      <IconButton
                        size="sm"
                        variant="plain"
                        color="neutral"
                        onClick={() => setFilesDropdownOpen(false)}
                        data-testid="close-files-dropdown"
                      >
                        <Close sx={{ fontSize: '1rem' }} />
                      </IconButton>
                    </Box>
                    <Box sx={{ p: 1 }}>
                      <FilesSection model={model} />
                    </Box>
                  </Menu>
                </Dropdown>
              )}

              <AdvancedAISettings
                stream={stream}
                setStream={setStream}
                spokenWords={spokenWords}
                setSpokenWords={setSpokenWords}
                onRollDice={rollRandomDice}
                currentSession={currentSession}
              />

              {/* Agent-mode toggle. Layer-1 gated - completely hidden
                  when the gate (`useFeatureEnabled('agentMode')`, resolved above)
                  is false, so non-gated users see the composer exactly as before. */}
              {agentModeFeatureEnabled && <AgentModeToggleButton disabled={submitting} />}

              {/* Action buttons: Rephrase, Voice Record, Stop/Send */}
              {!isMobile && chatInputValue && chatInputValue.trim() !== '' && (
                <RephraseButton
                  currentText={chatInputValue}
                  onRephrase={text => {
                    setChatInputValue(text);
                  }}
                  onSuccess={() => {
                    setRephraseGlow(true);
                    setTimeout(() => setRephraseGlow(false), 900);
                  }}
                  disabled={!chatInputValue || submitting}
                />
              )}
              {/* Voice record button is the default action when the composer is
                  empty. Once the user types, it's replaced by the send button
                  (see the send/stop block below). Also hidden when a voice
                  session is active.

                  `|| recording` keeps the button mounted while a recording is
                  in progress even if the user types - unmounting mid-recording
                  would orphan the live MediaStream (mic stays on) and strand the
                  Confirm button with a null ref. The button disappears once
                  recording ends. */}
              {!(isVoiceSessionEnabled && (voiceEngine.isActive || VOICE_DEBUG_STATE)) &&
                (!chatInputValue || chatInputValue.trim() === '' || recording) && (
                  <VoiceRecordButton
                    ref={voiceRecordRef}
                    onRecordingStart={() => setRecording(true)}
                    onRecordingError={() => setRecording(false)}
                    onRecordingEnd={async (prompt: string) => {
                      setRecording(false);
                      await handleSendClick(prompt);
                    }}
                    disabled={creditsBlocked}
                  />
                )}
              {/* Voice v2 - model-agnostic conversational voice (ElevenLabs CAI).
                  Gated by voiceV2Enabled admin setting; renders nothing otherwise.
                  Hidden once the composer has text so only the send button shows. */}
              {(!chatInputValue || chatInputValue.trim() === '') && (
                <ConversationalVoiceButton currentSessionId={currentSessionId} reasoningModelId={model} />
              )}
              {shouldShowStopButton ? (
                <Tooltip title="Stop Generation">
                  <Button
                    sx={{
                      borderRadius: '6px',
                      height: '32px',
                      width: '32px',
                      padding: 0,
                      bgcolor: 'danger.500',
                      '&:hover': {
                        bgcolor: 'danger.600',
                      },
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                    variant="solid"
                    color="danger"
                    size="sm"
                    disabled={stoppingMessage}
                    onClick={handleStopMessage}
                    data-testid="stop-generation-btn"
                  >
                    {stoppingMessage ? <CircularProgress size="sm" /> : <StopCircleSharp />}
                  </Button>
                </Tooltip>
              ) : isVoiceSessionEnabled && (voiceEngine.isActive || VOICE_DEBUG_STATE) ? (
                /* Voice session active: show controls strip inline where buttons were */
                <VoiceControlsStrip engine={voiceEngine} />
              ) : (
                <>
                  {/* Voice not active: show voice-chat-button or send button */}
                  {recording ? (
                    /* Recording active: confirm button to stop & submit transcription */
                    <Tooltip title="Confirm recording" placement="top">
                      <Button
                        sx={{
                          borderRadius: '6px',
                          paddingBlock: '0px',
                          ...fixedIconSize,
                        }}
                        variant="solid"
                        color="primary"
                        size="md"
                        onClick={() => voiceRecordRef.current?.confirmRecording()}
                        data-testid="voice-record-confirm-btn"
                      >
                        <Check sx={{ width: '18px', height: '18px' }} />
                      </Button>
                    </Tooltip>
                  ) : isVoiceSessionEnabled && (!chatInputValue || chatInputValue.trim() === '') ? (
                    <VoiceInlineButton
                      engine={voiceEngine}
                      onOpenDebugPanel={() => setDebugDrawerOpen(true)}
                      fixedIconSize={fixedIconSize}
                      creditsBlocked={creditsBlocked}
                    />
                  ) : !chatInputValue ||
                    chatInputValue.trim() === '' /* Empty composer: no send button - the voice record button
                       above serves as the default action. */ ? null : (
                    <Tooltip
                      title={
                        isModelsLoading
                          ? t('session.loadingModels', 'Loading AI models…')
                          : pendingAutoSubmitGoal
                            ? t('session.preparingQuest')
                            : t('session.sendMessage')
                      }
                      placement="top"
                    >
                      <Button
                        sx={{
                          borderRadius: '6px',
                          paddingBlock: '0px',
                          ...fixedIconSize,
                        }}
                        variant="solid"
                        color="primary"
                        disabled={
                          isModelsLoading ||
                          !chatInputValue ||
                          readyState !== ReadyState.OPEN ||
                          submitting ||
                          hasActiveUploads ||
                          chatInputValue.trim() === '' ||
                          !accessibleModels ||
                          accessibleModels.length === 0
                        }
                        size="md"
                        onClick={async () => await handleSendClick()}
                        data-testid="send-message-btn"
                      >
                        {submitting || pendingAutoSubmitGoal || isModelsLoading ? (
                          <CircularProgress data-testid="session-send-progress" />
                        ) : (
                          <Box
                            sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            data-testid="session-send-icon-wrapper"
                          >
                            <SendIcon sx={{ width: '13px', height: '13px' }} />
                          </Box>
                        )}
                      </Button>
                    </Tooltip>
                  )}
                </>
              )}
            </Box>
          </Box>
        </Box>
      </Box>
    </Stack>
  );
}
