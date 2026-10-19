import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * SessionToolbar's own markup: the send gate and the voice transcript gate. Every child is
 * stubbed. The Agent-mode toggle moved into the plus menu, and its admin-gate test with it
 * (AttachFileButton.plusMenu.test.tsx).
 */

const mocks = vi.hoisted(() => ({
  // onRecordingEnd from each VoiceRecordButton render, oldest first.
  voiceRecordingEnds: [] as ((prompt: string) => Promise<void>)[],
  // onRecordingStart from each VoiceRecordButton render, oldest first.
  voiceRecordingStarts: [] as (() => void)[],
  rowCompact: false,
}));

// Children and hooks reach `api` at module load.
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

// Re-mocked locally so any transitive import gets the ReadyState enum plus a benign
// useWebsocket (the global mock in vitest.setup.ts does not export ReadyState).
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), send: vi.fn(), isConnected: true }),
}));

// Stub every child SessionToolbar imports so only its own gate markup renders and
// no child pulls in its own context/`@/`-alias chain.
vi.mock('@client/app/components/Session/AttachFileButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AISettings/FilesSection', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => {
  // Reports the row as collapsed when the test says so, like the real overflow check would.
  const AdvancedAISettingsStub = ({ onCompactChange }: { onCompactChange?: (compact: boolean) => void }) => {
    React.useEffect(() => onCompactChange?.(mocks.rowCompact), [onCompactChange]);
    return <div data-testid="ai-settings-row" />;
  };
  return { default: AdvancedAISettingsStub };
});
vi.mock('@client/app/components/Session/RephraseButton', () => ({ default: () => <div data-testid="rephrase-btn" /> }));
vi.mock('@client/app/components/common/VoiceRecordButton', () => {
  const VoiceRecordButtonStub = React.forwardRef<
    HTMLDivElement,
    { onRecordingEnd: (prompt: string) => Promise<void>; onRecordingStart: () => void }
  >(props => {
    mocks.voiceRecordingEnds.push(props.onRecordingEnd);
    mocks.voiceRecordingStarts.push(props.onRecordingStart);
    return <div data-testid="voice-record-btn" />;
  });
  VoiceRecordButtonStub.displayName = 'VoiceRecordButtonStub';
  return { default: VoiceRecordButtonStub };
});
vi.mock('@client/app/components/Session/VoiceSessionModal/VoiceInlineIndicator', () => ({
  default: () => null,
  VoiceControlsStrip: () => null,
  VOICE_DEBUG_STATE: false,
}));
vi.mock('@client/app/components/Session/ConversationalVoice/ConversationalVoiceButton', () => ({
  default: () => <div data-testid="conversational-voice-btn" />,
}));

import { SessionToolbar, appendTranscript } from './SessionToolbar';
import { useConversationalVoiceStore } from '@client/app/components/Session/ConversationalVoice/useConversationalVoice';
import { useChatInput } from '@client/app/hooks/useChatInput';
import { act } from '@testing-library/react';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

// All ~40 SessionToolbar props (SessionToolbar.tsx:33-91). Handlers are vi.fn(),
// the composer is empty and no voice session is active so the render stays on the
// simplest branch (no send/stop button, no files dropdown).
const baseProps = {
  isMobile: false,
  mode: 'light' as const,
  canAttachFiles: true,
  workBenchFiles: [],
  currentSessionId: null,
  currentSession: null,
  setWorkBenchFiles: vi.fn(),
  setCurrentSession: vi.fn(),
  toggleFileUpload: vi.fn(),
  setFileBrowserOpen: vi.fn(),
  rollRandomDice: vi.fn(),
  isSessionFileMode: false,
  setIsSessionFileMode: vi.fn(),
  totalFilesCount: 0,
  hasEmbeddingMismatches: false,
  model: 'gpt-4o',
  filesDropdownOpen: false,
  setFilesDropdownOpen: vi.fn(),
  chatInputValue: '',
  setChatInputValue: vi.fn(),
  setRephraseGlow: vi.fn(),
  stream: true,
  setStream: vi.fn(),
  spokenWords: 0,
  setSpokenWords: vi.fn(),
  submitting: false,
  stoppingMessage: false,
  shouldShowStopButton: false,
  handleSendClick: vi.fn(),
  handleStopMessage: vi.fn(),
  pendingAutoSubmitGoal: null,
  sendBlockedReason: null,
  isModelsLoading: false,
  isVoiceSessionEnabled: false,
  voiceEngine: null,
  creditsBlocked: false,
  setDebugDrawerOpen: vi.fn(),
};

beforeEach(() => {
  mocks.voiceRecordingEnds.length = 0;
  mocks.voiceRecordingStarts.length = 0;
  mocks.rowCompact = false;
  useConversationalVoiceStore.setState({ phase: 'idle' });
});

describe('SessionToolbar - narrow pane layout', () => {
  // jsdom has no layout engine, so this pins the CSS. A narrow pane folds the model, Tools and
  // Agents to icons (useOverflowCompact); a wrapping row would never overflow, so they would not fold.
  it('keeps the actions row on one line', () => {
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    const row = screen.getByTestId('session-bottom-actions');
    expect(getComputedStyle(row).flexWrap).not.toBe('wrap');
  });
});

describe('SessionToolbar - Send button blocked reason', () => {
  it('disables Send and exposes why when the socket is reconnecting', () => {
    render(<SessionToolbar {...baseProps} chatInputValue="hello" sendBlockedReason="reconnecting" />, {
      wrapper: Wrapper,
    });
    expect(screen.getByTestId('send-message-btn')).toBeDisabled();
    expect(screen.getByTestId('send-message-btn-wrapper')).toHaveAttribute('data-blocked-reason', 'reconnecting');
  });

  it('enables Send with no blocked reason when nothing blocks it', () => {
    render(<SessionToolbar {...baseProps} chatInputValue="hello" />, { wrapper: Wrapper });
    expect(screen.getByTestId('send-message-btn')).not.toBeDisabled();
    expect(screen.getByTestId('send-message-btn-wrapper')).not.toHaveAttribute('data-blocked-reason');
  });
});

describe('SessionToolbar - optimize prompt', () => {
  it.each([false, true])('puts Optimize beside Send instead of dictation once there is text (phone: %s)', isMobile => {
    render(<SessionToolbar {...baseProps} isMobile={isMobile} chatInputValue="draft" />, { wrapper: Wrapper });
    expect(screen.getByTestId('rephrase-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('voice-record-btn')).toBeNull();
  });

  it('offers dictation, not Optimize, while the composer is empty', () => {
    render(<SessionToolbar {...baseProps} isMobile />, { wrapper: Wrapper });
    expect(screen.queryByTestId('rephrase-btn')).toBeNull();
    expect(screen.getByTestId('voice-record-btn')).toBeInTheDocument();
  });
});

describe('SessionToolbar - dictation', () => {
  it('hides the voice session while a prompt is being dictated, leaving the recording and its confirm', () => {
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    expect(screen.getByTestId('conversational-voice-btn')).toBeInTheDocument();
    act(() => mocks.voiceRecordingStarts.at(-1)?.());
    expect(screen.queryByTestId('conversational-voice-btn')).toBeNull();
    expect(screen.getByTestId('voice-record-confirm-btn')).toBeInTheDocument();
  });
});

describe('SessionToolbar - voice pill in a collapsed row or on phones', () => {
  it('keeps the model, Tools and Agents beside the recording at full width', () => {
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    act(() => mocks.voiceRecordingStarts.at(-1)?.());
    expect(screen.getByTestId('ai-settings-row')).toBeVisible();
  });

  it('gives their space to the recording once the row has collapsed to icons', () => {
    mocks.rowCompact = true;
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    expect(screen.getByTestId('ai-settings-row')).toBeVisible();
    act(() => mocks.voiceRecordingStarts.at(-1)?.());
    expect(screen.getByTestId('ai-settings-row')).not.toBeVisible();
  });

  it('gives their space to the recording on phones, where the model holds the row alone', () => {
    render(<SessionToolbar {...baseProps} isMobile />, { wrapper: Wrapper });
    act(() => mocks.voiceRecordingStarts.at(-1)?.());
    expect(screen.getByTestId('ai-settings-row')).not.toBeVisible();
  });
});

describe('SessionToolbar - voice call', () => {
  it('hides dictation while a Voice v2 call is up, leaving the call controls', () => {
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    expect(screen.getByTestId('voice-record-btn')).toBeInTheDocument();
    act(() => useConversationalVoiceStore.setState({ phase: 'connected' }));
    expect(screen.queryByTestId('voice-record-btn')).toBeNull();
    expect(screen.getByTestId('conversational-voice-btn')).toBeInTheDocument();
  });
});

describe('SessionToolbar - voice transcript gate', () => {
  // The real VoiceRecordButton binds onRecordingEnd into mediaRecorder.onstop when recording
  // STARTS, so the first-render callback is the one that fires at transcript time.
  it('reads the gate at transcript time, not from the render recording started in', async () => {
    const handleSendClick = vi.fn();
    const setChatInputValue = vi.fn();
    useChatInput.setState({ chatInputValue: '' });
    const { rerender } = render(
      <SessionToolbar {...baseProps} handleSendClick={handleSendClick} setChatInputValue={setChatInputValue} />,
      { wrapper: Wrapper }
    );
    const capturedAtStart = mocks.voiceRecordingEnds[0];

    rerender(
      <SessionToolbar
        {...baseProps}
        handleSendClick={handleSendClick}
        setChatInputValue={setChatInputValue}
        sendBlockedReason="reconnecting"
      />
    );
    await act(async () => {
      await capturedAtStart('spoken words');
    });

    expect(handleSendClick).not.toHaveBeenCalled();
    expect(setChatInputValue).toHaveBeenCalledWith('spoken words');
  });

  it('sends when the gate cleared while recording', async () => {
    const handleSendClick = vi.fn();
    const { rerender } = render(
      <SessionToolbar {...baseProps} handleSendClick={handleSendClick} sendBlockedReason="reconnecting" />,
      { wrapper: Wrapper }
    );
    const capturedAtStart = mocks.voiceRecordingEnds[0];

    rerender(<SessionToolbar {...baseProps} handleSendClick={handleSendClick} />);
    await act(async () => {
      await capturedAtStart('spoken words');
    });

    expect(handleSendClick).toHaveBeenCalledWith('spoken words');
  });

  it('appends a blocked transcript after text already typed instead of replacing it', async () => {
    const setChatInputValue = vi.fn();
    useChatInput.setState({ chatInputValue: 'typed draft ' });
    render(<SessionToolbar {...baseProps} setChatInputValue={setChatInputValue} sendBlockedReason="uploading" />, {
      wrapper: Wrapper,
    });

    await act(async () => {
      await mocks.voiceRecordingEnds[0]('and spoken');
    });

    expect(setChatInputValue).toHaveBeenCalledWith('typed draft and spoken');
  });
});

describe('appendTranscript', () => {
  it('uses the transcript alone for an empty composer', () => {
    expect(appendTranscript('  ', 'hello')).toBe('hello');
  });

  it('joins onto existing text with a single space', () => {
    expect(appendTranscript('draft\n', 'hello')).toBe('draft hello');
  });
});
