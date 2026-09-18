import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Covers the "Only tools I pick" row - the surface half of the auto-offer lever.
 *
 * LLMCommand.payload.test.ts proves the request body carries `skipAutoOffers` once an arg sets
 * it; nothing there would notice this toggle writing the wrong store key, which would leave the
 * control inert while every wire assertion still passed. These tests close that gap by asserting
 * on the exact key written to the store.
 */

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    tools: [],
    toolMode: 'smart',
    isQuestMasterEnabled: false,
    isAgentsEnabled: false,
    agentMode: { enabled: false, source: 'toggle' },
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
  return { state, useLLM };
});

vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: mocks.useLLM }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: (selector: (s: { liveAI: boolean }) => unknown) => selector({ liveAI: true }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({
    settings: {
      toolsCatalogCollapsed: false,
      rechartsDisplayMode: 'inline',
      experimentalFeatures: { agentMode: false },
      agentModeDefault: 'off',
    },
    updatePreferences: vi.fn(),
  }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: () => false, isAdminFeatureEnabled: () => false }),
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }] }),
}));
vi.mock('@client/app/hooks/data/mcpServers', () => ({
  useMcpServers: () => ({ data: [], isPending: false, isFetching: false }),
}));
vi.mock('@client/app/hooks/data/settings', () => ({
  useConfig: () => ({ data: { toolAvailability: undefined } }),
}));
vi.mock('./DeepResearchConfigModal', () => ({ default: () => null }));
vi.mock('./ImageGenerationModelSelectionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ToolsSection from './ToolsSection';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const toggleOf = (container: HTMLElement) => container.querySelector('[data-testid="tools-skip-auto-offers-toggle"]');

beforeEach(() => {
  mocks.state.skipAutoOffers = false;
  mocks.useLLM.setState.mockClear();
});

describe('ToolsSection - "Only tools I pick" row', () => {
  it('renders the row', () => {
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(toggleOf(container)).toBeTruthy();
  });

  it('writes skipAutoOffers: true to the store when switched on', () => {
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(toggleOf(container)!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ skipAutoOffers: true });
  });

  it('writes skipAutoOffers: false when switched back off', () => {
    mocks.state.skipAutoOffers = true;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(toggleOf(container)!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ skipAutoOffers: false });
  });

  it('reflects the stored value in the control', () => {
    mocks.state.skipAutoOffers = true;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(toggleOf(container)!.getAttribute('aria-checked')).toBe('true');
  });

  // The flag also feeds `offerOnlyNamedTools`, which withholds every non-agent-only MCP
  // tool (sharedToolBuilder.ts). MCP servers are picked per server in this same panel and
  // nothing in the UI names an individual MCP tool, so a user who reads only the label has
  // no way to learn that turning this on drops the integrations they toggled on above.
  it('tells the user that connected integrations are withheld too', () => {
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    const row = container.querySelector('.tool-item-skip-auto-offers');
    expect(row?.textContent).toContain('integrations');
    expect(row?.textContent).toContain('Turn this off');
  });
});
