import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

// The Thinking row: a toggle for models that can switch thinking off, a fixed label for those that cannot.

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    tools: [],
    toolMode: 'smart',
    isQuestMasterEnabled: false,
    isAgentsEnabled: false,
    agentMode: { enabled: true, source: 'toggle' },
    isLatticeEnabled: false,
    researchMode: { enabled: false },
    enabledMcpServers: null,
    model: 'gpt-4o',
    thinking: { enabled: false, budget_tokens: 16000 },
    disableAutoRouteForThisSession: false,
    skipAutoOffers: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const experimentalAgentMode = { value: true };
  // Controls for the predicted complexity auto-route path.
  const agentModeFeatureFlag = { value: false }; // isFeatureEnabled('agentMode')
  const agentModeDefault = { value: 'off' as 'off' | 'auto' | 'on' };
  const chatDraft = { value: '' };
  const liveAI = { value: true }; // useAdvancedAISettings(state => state.liveAI); default on
  // serverConfig.toolAvailability from useConfig(); undefined = not yet loaded (never gates).
  const toolAvailability = { value: undefined as Record<string, boolean> | undefined };
  // Admin feature flags (isAdminFeatureEnabled); default all off so rows behind a flag
  // (e.g. the Knowledge Base row) stay hidden unless a test opts in.
  const adminFeatureFlags = { value: {} as Record<string, boolean> };
  return {
    state,
    useLLM,
    experimentalAgentMode,
    agentModeFeatureFlag,
    agentModeDefault,
    chatDraft,
    liveAI,
    toolAvailability,
    adminFeatureFlags,
  };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: (selector: (s: { liveAI: boolean }) => unknown) => selector({ liveAI: mocks.liveAI.value }),
}));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: (selector: (s: { chatInputValue: string }) => unknown) =>
    selector({ chatInputValue: mocks.chatDraft.value }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: {
      toolsCatalogCollapsed: false,
      rechartsDisplayMode: 'inline',
      experimentalFeatures: { agentMode: mocks.experimentalAgentMode.value },
      agentModeDefault: mocks.agentModeDefault.value,
    },
    updatePreferences: vi.fn(),
  }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({
    isFeatureEnabled: (feature: string) => (feature === 'agentMode' ? mocks.agentModeFeatureFlag.value : false),
    isAdminFeatureEnabled: (feature: string) => mocks.adminFeatureFlags.value[feature] ?? false,
  }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({
    data: [
      {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        supportsTools: true,
        can_think: true,
        thinkingStyle: 'adaptive',
        thinkingAlwaysOn: true,
      },
      { id: 'claude-opus-5', name: 'Claude Opus 5', supportsTools: true, can_think: true, thinkingStyle: 'adaptive' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', supportsTools: true, can_think: true, thinkingAlwaysOn: true },
    ],
  }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({ data: [], isPending: false, isFetching: false }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: mocks.toolAvailability.value } }),
}));
vi.mock('./DeepResearchConfigModal', () => ({ default: () => null }));
vi.mock('./ImageGenerationModelSelectionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ToolsSection from './ToolsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const thinkingRow = (container: HTMLElement) => container.querySelector('.tool-item-thinking') as HTMLElement;

beforeEach(() => {
  mocks.useLLM.setState.mockClear();
  mocks.state.toolMode = 'smart';
  mocks.state.thinking = { enabled: true, budget_tokens: 16000 };
});

describe('ToolsSection thinking row', () => {
  it('shows a fixed always-on label pointing at Reasoning Effort, with no toggle or budget, for Opus 5.5', () => {
    mocks.state.model = 'claude-opus-5-5';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    const row = thinkingRow(container);
    expect(screen.getByTestId('tools-thinking-always-on')).toBeTruthy();
    expect(row.textContent).toContain('Reasoning Effort');
    expect(screen.queryByTestId('tools-thinking-toggle-btn')).toBeNull();
    expect(row.querySelector('input[type="number"]')).toBeNull();
  });

  it('keeps the toggle and budget input for Opus 5, which can switch thinking off', () => {
    mocks.state.model = 'claude-opus-5';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    const row = thinkingRow(container);
    expect(screen.queryByTestId('tools-thinking-always-on')).toBeNull();
    fireEvent.click(screen.getByTestId('tools-thinking-toggle-btn'));
    expect(mocks.useLLM.setState).toHaveBeenCalledWith(
      expect.objectContaining({ thinking: { enabled: false, budget_tokens: 16000 } })
    );
    expect(row.querySelector('input[type="number"]')).toBeTruthy();
  });

  it('shows always-on without a Reasoning Effort pointer for Kimi K2.7 Code', () => {
    mocks.state.model = 'kimi-k2.7-code';
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(screen.getByTestId('tools-thinking-always-on')).toBeTruthy();
    expect(thinkingRow(container).textContent).not.toContain('Reasoning Effort');
    expect(screen.queryByTestId('tools-thinking-toggle-btn')).toBeNull();
  });
});
