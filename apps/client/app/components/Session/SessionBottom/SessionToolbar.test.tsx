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

// The global WebsocketContext mock in vitest.setup.ts does NOT export `ReadyState`,
// but SessionToolbar imports it (and this test uses ReadyState.OPEN for baseProps).
// Re-mock locally to provide the enum plus a benign useWebsocket.
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
  const VoiceRecordButtonStub = React.forwardRef<HTMLDivElement>(() => null);
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

import { SessionToolbar } from './SessionToolbar';
import { ReadyState } from '@client/app/contexts/WebsocketContext';

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
  readyState: ReadyState.OPEN,
  hasActiveUploads: false,
  accessibleModels: [],
  isModelsLoading: false,
  isVoiceSessionEnabled: false,
  voiceEngine: null,
  creditsBlocked: false,
  setDebugDrawerOpen: vi.fn(),
};

beforeEach(() => {
  mocks.agentModeFlag.value = false;
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
