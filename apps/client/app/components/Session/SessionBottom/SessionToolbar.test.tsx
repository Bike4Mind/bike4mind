import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Consumer-level regression guard for the Agent Mode admin kill switch.
 *
 * Agent Mode is admin-gated. A prior P1 fixed SessionToolbar bypassing the admin
 * gate by reading `experimentalFeatures.agentMode` directly; it now resolves the
 * Layer-1 gate via `useFeatureEnabled('agentMode')` (SessionToolbar.tsx:147-148),
 * and the toggle wrapper (AgentModeToggleButton) mounts only when that gate is
 * true (SessionToolbar.tsx:338).
 *
 * Scope: the toggle is stubbed to an always-rendering div, so these assertions
 * prove the gate *wrapper* condition, not the toggle's own on/off styling.
 *
 * This test locks the consumer behavior: the gated toggle mounts when the gate is
 * on and is absent when the admin kill switch is off. It fails if the render
 * condition is swapped back to a raw `experimentalFeatures.agentMode` read, because
 * the mock only controls the resolved `isFeatureEnabled('agentMode')` value.
 */

const mocks = vi.hoisted(() => ({
  // Resolved value of isFeatureEnabled('agentMode') - the Layer-1 admin gate.
  agentModeFlag: { value: false },
  // onRecordingEnd from each VoiceRecordButton render, oldest first.
  voiceRecordingEnds: [] as ((prompt: string) => Promise<void>)[],
}));

// The kill switch under test: SessionToolbar reads the gate through this hook.
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => (feature === 'agentMode' ? mocks.agentModeFlag.value : false),
    isAdminFeatureEnabled: () => false,
    // SessionToolbar ignores isLoading, but the real hook returns it. Keep the mock
    // shape complete so copies of this harness that gate on it (to suppress a flash
    // of the gate during hydration) don't silently read undefined.
    isLoading: false,
  }),
}));

// SessionToolbar imports `api` at module load (used inside onOptimizePrompt).
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: vi.fn(), get: vi.fn() } }));

// Re-mocked locally so any transitive import gets the ReadyState enum plus a benign
// useWebsocket (the global mock in vitest.setup.ts does not export ReadyState).
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  ReadyState: { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
  useWebsocket: () => ({ subscribe: vi.fn(), unsubscribe: vi.fn(), send: vi.fn(), isConnected: true }),
}));

// Stub every child SessionToolbar imports so only its own gate markup renders and
// no child pulls in its own context/`@/`-alias chain. The agent-mode toggle keeps
// its testid so the gate is observable without mounting LLMContext.
vi.mock('@client/app/components/Session/SessionBottom/AgentModeToggleButton', () => ({
  default: () => <div data-testid="agent-mode-toggle-btn" />,
}));
vi.mock('@client/app/components/Session/AttachFileButton', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AISettings/FilesSection', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({ default: () => null }));
vi.mock('@client/app/components/Session/RephraseButton', () => ({ default: () => null }));
vi.mock('@client/app/components/common/VoiceRecordButton', () => {
  const VoiceRecordButtonStub = React.forwardRef<HTMLDivElement, { onRecordingEnd: (prompt: string) => Promise<void> }>(
    props => {
      mocks.voiceRecordingEnds.push(props.onRecordingEnd);
      return null;
    }
  );
  VoiceRecordButtonStub.displayName = 'VoiceRecordButtonStub';
  return { default: VoiceRecordButtonStub };
});
vi.mock('@client/app/components/Session/VoiceSessionModal/VoiceInlineIndicator', () => ({
  default: () => null,
  VoiceControlsStrip: () => null,
  VOICE_DEBUG_STATE: false,
}));
vi.mock('@client/app/components/Session/ConversationalVoice/ConversationalVoiceButton', () => ({
  default: () => null,
}));

import { SessionToolbar, appendTranscript } from './SessionToolbar';
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
  mocks.agentModeFlag.value = false;
  mocks.voiceRecordingEnds.length = 0;
});

describe('SessionToolbar - Agent Mode admin kill switch', () => {
  it('renders the Agent-mode bolt when the agentMode gate is enabled', () => {
    mocks.agentModeFlag.value = true; // admin gate ON
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    expect(screen.getByTestId('agent-mode-toggle-btn')).toBeInTheDocument();
  });

  it('does NOT render the Agent-mode bolt when the admin kill switch is off', () => {
    mocks.agentModeFlag.value = false; // admin kill switch OFF
    render(<SessionToolbar {...baseProps} />, { wrapper: Wrapper });
    expect(screen.queryByTestId('agent-mode-toggle-btn')).toBeNull();
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
