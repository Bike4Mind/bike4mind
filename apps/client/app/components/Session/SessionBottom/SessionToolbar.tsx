import type { AttachScopeMode } from '@bike4mind/common';
import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Box, CircularProgress } from '@mui/joy';
import Button from '@mui/joy/Button';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import { StopCircleSharp, Check } from '@mui/icons-material';
import SendIcon from '@mui/icons-material/Send';
import { useTranslation } from 'react-i18next';

import { IFabFileDocument, ISessionDocument } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';
import { fixedIconSize } from './sessionBottomConstants';
import { getSendBlockedLabel, type SendBlockedReason } from './sendBlockedReason';
import { useChatInput } from '@client/app/hooks/useChatInput';

import AttachFileButton from '@client/app/components/Session/AttachFileButton';
import AdvancedAISettings from '@client/app/components/Session/AdvancedAISettings';
import RephraseButton from '@client/app/components/Session/RephraseButton';
import VoiceRecordButton, { VoiceRecordButtonRef } from '@client/app/components/common/VoiceRecordButton';
import VoiceInlineButton, {
  VoiceControlsStrip,
  VOICE_DEBUG_STATE,
} from '@client/app/components/Session/VoiceSessionModal/VoiceInlineIndicator';
import ConversationalVoiceButton from '@client/app/components/Session/ConversationalVoice/ConversationalVoiceButton';

interface SessionToolbarProps {
  // Layout
  isMobile: boolean;

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
  attachScopeMode: AttachScopeMode;
  setAttachScopeMode: (mode: AttachScopeMode) => void;
  totalFilesCount: number;
  model: string;

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
  // Computed once in SessionBottom so the button, Enter and voice share one gate.
  sendBlockedReason: SendBlockedReason | null;

  // Models loading
  isModelsLoading: boolean;

  // Voice
  isVoiceSessionEnabled: boolean | string | number | undefined;
  voiceEngine: any;
  creditsBlocked: boolean;
  setDebugDrawerOpen: (open: boolean) => void;
}

/** Joins a voice transcript onto existing composer text. */
export function appendTranscript(existing: string, transcript: string): string {
  if (!existing.trim()) return transcript;
  return `${existing.replace(/\s+$/, '')} ${transcript}`;
}

export function SessionToolbar(props: SessionToolbarProps) {
  const { t } = useTranslation();
  const {
    isMobile,
    canAttachFiles,
    workBenchFiles,
    currentSessionId,
    currentSession,
    setWorkBenchFiles,
    setCurrentSession,
    toggleFileUpload,
    setFileBrowserOpen,
    rollRandomDice,
    attachScopeMode,
    setAttachScopeMode,
    totalFilesCount,
    model,
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
    sendBlockedReason,
    isModelsLoading,
    isVoiceSessionEnabled,
    voiceEngine,
    creditsBlocked,
    setDebugDrawerOpen,
  } = props;

  // Toolbar-local state
  const voiceRecordRef = useRef<VoiceRecordButtonRef>(null);
  const [recording, setRecording] = useState(false);
  const [isSettingsExiting] = useState(false);

  const sendBlockedLabel = sendBlockedReason ? getSendBlockedLabel(sendBlockedReason, t) : null;
  // VoiceRecordButton captures onRecordingEnd when recording starts, so the gate has to be
  // read at transcript time, not from that render's closure.
  const sendBlockedLabelRef = useRef(sendBlockedLabel);
  useEffect(() => {
    sendBlockedLabelRef.current = sendBlockedLabel;
  }, [sendBlockedLabel]);

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
                  attachScopeMode={attachScopeMode}
                  onAttachScopeModeChange={setAttachScopeMode}
                  totalFilesCount={totalFilesCount}
                  chatInputValue={chatInputValue}
                  agentModeDisabled={submitting}
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

              <AdvancedAISettings
                stream={stream}
                setStream={setStream}
                spokenWords={spokenWords}
                setSpokenWords={setSpokenWords}
                onRollDice={rollRandomDice}
                currentSession={currentSession}
              />

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
                      // Keep the transcript rather than drop it when a send isn't allowed yet,
                      // after whatever is already in the composer (SyncValuePlugin mirrors the
                      // store into the editor, as for a rephrase).
                      const blockedLabel = sendBlockedLabelRef.current;
                      if (blockedLabel) {
                        const existing = useChatInput.getState().chatInputValue;
                        setChatInputValue(appendTranscript(existing, prompt));
                        toast.info(blockedLabel);
                        return;
                      }
                      await handleSendClick(prompt);
                    }}
                    disabled={creditsBlocked}
                  />
                )}
              {/* Voice v2 - model-agnostic conversational voice (ElevenLabs CAI).
                  Gated by voiceV2Enabled admin setting; renders nothing otherwise.
                  Hidden once the composer has text so only the send button shows, and while a
                  prompt is being dictated so only the recording and its confirm button show. */}
              {!recording && (!chatInputValue || chatInputValue.trim() === '') && (
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
                        sendBlockedLabel ??
                        (pendingAutoSubmitGoal ? t('session.preparingQuest') : t('session.sendMessage'))
                      }
                      placement="top"
                    >
                      {/* A disabled button fires no pointer events, so the tooltip hangs off this wrapper. */}
                      <span
                        data-testid="send-message-btn-wrapper"
                        data-blocked-reason={sendBlockedReason ?? undefined}
                        style={{ display: 'inline-flex' }}
                      >
                        <Button
                          sx={{
                            borderRadius: '6px',
                            paddingBlock: '0px',
                            ...fixedIconSize,
                          }}
                          variant="solid"
                          color="primary"
                          disabled={!!sendBlockedReason || !chatInputValue || chatInputValue.trim() === ''}
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
                      </span>
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
