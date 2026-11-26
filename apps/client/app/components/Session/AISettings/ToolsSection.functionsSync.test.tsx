import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  connections: { value: [] as Array<Record<string, unknown>> },
  functions: { on: true, list: [{ slug: 'beam', status: 'live', trustLabel: 'verified' }] },
}));
vi.mock('@client/app/contexts/LLMContext', async () => {
  const { create } = await import('zustand');
  return {
    useLLM: create<Record<string, unknown>>(() => ({
      tools: [],
      toolMode: 'smart',
      isAgentsEnabled: false,
      agentMode: { enabled: false, source: 'toggle' },
      isLatticeEnabled: false,
      researchMode: { enabled: false },
      enabledMcpServers: [],
      model: 'gpt-4o',
      thinking: { enabled: false, budget_tokens: 16000 },
      disableAutoRouteForThisSession: false,
      skipAutoOffers: false,
      disabledMcpConnections: [],
      enabledPlatformMcpConnections: [],
    })),
  };
});
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
vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => mocks.functions.on,
  useCallableFunctionList: (enabled: boolean) => ({ data: enabled ? mocks.functions.list : undefined }),
}));
vi.mock('./DeepResearchConfigModal', () => ({ default: () => null }));
vi.mock('./ImageGenerationModelSelectionModal', () => ({ default: () => null }));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));

import ToolsSection from './ToolsSection';
import { useLLM } from '@client/app/contexts/LLMContext';
import { useMcpServerSync } from '../SessionBottom/useMcpServerSync';

const theme = extendTheme({ ...getThemeConfig() });
function ComposerTools() {
  useMcpServerSync();
  return (
    <CssVarsProvider theme={theme}>
      <ToolsSection />
    </CssVarsProvider>
  );
}
const functionsToggle = () => screen.getByTestId('tool-toggle-functions');
beforeEach(() => {
  useLLM.setState(useLLM.getInitialState(), true);
  mocks.connections.value = [];
  mocks.functions.on = true;
});

describe('Functions choice through the composer synchronization effect', () => {
  it('stays off after a real toggle, effect flush and remount with no custom connectors', async () => {
    const first = render(<ComposerTools />);
    fireEvent.click(functionsToggle());
    await waitFor(() => expect(functionsToggle().getAttribute('aria-checked')).toBe('false'));
    expect(useLLM.getState().disabledMcpConnections).toEqual(['_fn']);
    first.unmount();
    render(<ComposerTools />);
    expect(functionsToggle().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(functionsToggle());
    await waitFor(() => expect(functionsToggle().getAttribute('aria-checked')).toBe('true'));
    expect(useLLM.getState().disabledMcpConnections).toEqual([]);
  });

  it('keeps a legacy fn connector choice independent while pruning deleted connectors', async () => {
    mocks.connections.value = [
      { id: 'legacy', slug: 'fn', displayName: 'Legacy connector', urlHost: 'legacy.example.test' },
      { id: 'acme', slug: 'acme', displayName: 'Acme', urlHost: 'acme.example.test' },
    ];
    useLLM.setState({ disabledMcpConnections: ['_fn', 'fn', 'acme', 'gone'] });
    render(<ComposerTools />);
    await waitFor(() => expect(useLLM.getState().disabledMcpConnections).toEqual(['_fn', 'fn', 'acme']));
    fireEvent.click(functionsToggle());
    await waitFor(() => expect(functionsToggle().getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByTestId('tool-toggle-mcp-connection-fn').getAttribute('aria-checked')).toBe('false');
    expect(useLLM.getState().disabledMcpConnections).toEqual(['fn', 'acme']);
    fireEvent.click(screen.getByTestId('tool-toggle-mcp-connection-fn'));
    expect(functionsToggle().getAttribute('aria-checked')).toBe('true');
    expect(useLLM.getState().disabledMcpConnections).toEqual(['acme']);
  });
});
