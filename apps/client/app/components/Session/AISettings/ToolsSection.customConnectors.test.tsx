import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * Custom MCP connector rows in the Tools menu. They write an opt-out list
 * (`disabledMcpConnections`), so these tests assert the exact key and value written to the store:
 * a wrong key would leave the switch inert while the request wiring tests still passed.
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
    disabledMcpConnections: [] as string[],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const connections = { value: [] as Array<Record<string, unknown>> };
  return { state, useLLM, connections };
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
vi.mock('@client/app/hooks/useComposerMcpConnections', () => ({
  useComposerMcpConnections: () => ({ all: mocks.connections.value, offered: mocks.connections.value, loaded: true }),
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

const toggleOf = (container: HTMLElement, slug: string) =>
  container.querySelector(`[data-testid="tool-toggle-mcp-connection-${slug}"]`);

beforeEach(() => {
  mocks.state.disabledMcpConnections = [];
  mocks.connections.value = [
    { id: 'c1', slug: 'acme', displayName: 'Acme tracker', urlHost: 'mcp.acme.test' },
    { id: 'c2', slug: 'docs', displayName: 'Docs', urlHost: 'mcp.docs.test' },
  ];
  mocks.useLLM.setState.mockClear();
});

describe('ToolsSection - custom MCP connector rows', () => {
  it('lists each offered connector by name and host, on unless switched off', () => {
    mocks.state.disabledMcpConnections = ['docs'];
    const { container, getByText } = render(<ToolsSection />, { wrapper: Wrapper });

    expect(getByText('Acme tracker')).toBeTruthy();
    expect(getByText('Custom connector on mcp.acme.test')).toBeTruthy();
    expect(toggleOf(container, 'acme')!.getAttribute('aria-checked')).toBe('true');
    expect(toggleOf(container, 'docs')!.getAttribute('aria-checked')).toBe('false');
  });

  it('adds a connector to the opt-out list when switched off', () => {
    mocks.state.disabledMcpConnections = ['docs'];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(toggleOf(container, 'acme')!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ disabledMcpConnections: ['docs', 'acme'] });
  });

  it('removes a connector from the opt-out list when switched back on', () => {
    mocks.state.disabledMcpConnections = ['docs', 'acme'];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(toggleOf(container, 'docs')!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ disabledMcpConnections: ['acme'] });
  });

  it('renders no connector row when none is offered', () => {
    mocks.connections.value = [];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(container.querySelector('[data-testid^="tool-toggle-mcp-connection-"]')).toBeNull();
  });
});
