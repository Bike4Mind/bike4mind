import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    enabledPlatformMcpConnections: [] as string[],
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double for the Zustand hook (selector + setState)
  const useLLM: any = (selector: (s: Record<string, unknown>) => unknown) => selector(state);
  useLLM.setState = vi.fn();
  const connections = { value: [] as Array<Record<string, unknown>> };
  const functions = { on: false, list: [] as Array<Record<string, unknown>> };
  return { state, useLLM, connections, functions };
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
vi.mock('@client/app/hooks/data/callableFunctions', () => ({
  useCallableFunctionsEnabled: () => mocks.functions.on,
  useCallableFunctionList: (enabled: boolean) => ({ data: enabled ? mocks.functions.list : undefined }),
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
  mocks.state.enabledPlatformMcpConnections = [];
  mocks.connections.value = [
    { id: 'c1', slug: 'acme', displayName: 'Acme tracker', urlHost: 'mcp.acme.test' },
    { id: 'c2', slug: 'docs', displayName: 'Docs', urlHost: 'mcp.docs.test' },
  ];
  mocks.useLLM.setState.mockClear();
  mocks.functions.on = false;
  mocks.functions.list = [];
});

describe('ToolsSection - Functions row', () => {
  const row = (container: HTMLElement) => container.querySelector('.tool-item-functions') as HTMLElement | null;
  const toggle = (container: HTMLElement) => container.querySelector('[data-testid="tool-toggle-functions"]');

  it('is absent while callable functions are off', () => {
    mocks.functions.list = [{ slug: 'beam', status: 'live', trustLabel: 'verified' }];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(row(container)).toBeNull();
  });

  it('names each live tool with its label, with no custom connector at all, and is on by default', () => {
    mocks.functions.on = true;
    mocks.connections.value = [];
    mocks.functions.list = [
      { slug: 'beam_deflection', status: 'live', trustLabel: 'verified' },
      { slug: 'draft_tool', status: 'draft', trustLabel: null },
      { slug: 'off_tool', status: 'disabled', trustLabel: null },
      { slug: 'pipe_flow', status: 'live', trustLabel: 'unverified' },
    ];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });

    expect(within(row(container)!).getByText('Functions')).toBeTruthy();
    expect(within(row(container)!).getByText('beam_deflection (verified), pipe_flow (unverified)')).toBeTruthy();
    expect(toggle(container)!.getAttribute('aria-checked')).toBe('true');
  });

  it('says what the platform label means when an offered tool carries it', () => {
    mocks.functions.on = true;
    mocks.functions.list = [
      { slug: 'beam_deflection', status: 'live', trustLabel: 'platform' },
      { slug: 'pipe_flow', status: 'live', trustLabel: 'unverified' },
    ];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });

    expect(
      within(row(container)!).getByText(
        'beam_deflection (platform), pipe_flow (unverified). Platform: curated and checked by Bike4Mind.'
      )
    ).toBeTruthy();
  });

  it('names the first 20 live tools and counts the rest, with the cap in its detail', () => {
    mocks.functions.on = true;
    mocks.functions.list = Array.from({ length: 23 }, (_, i) => ({
      slug: `tool_${i}`,
      status: 'live',
      trustLabel: 'verified',
    }));
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });

    const first20 = Array.from({ length: 20 }, (_, i) => `tool_${i} (verified)`).join(', ');
    expect(within(row(container)!).getByText(`${first20}, and 3 more not offered`)).toBeTruthy();
    expect(
      within(row(container)!).getByText('Up to 20 of your live tools, run on the server with a stamp')
    ).toBeTruthy();
  });

  it('says how to get a tool there when none is live', () => {
    mocks.functions.on = true;
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(
      within(row(container)!).getByText('No live tools yet. Promote a saved tool to offer it in chat.')
    ).toBeTruthy();
  });

  it('switches off by adding the function key to the opt-out list, and back on by removing it', () => {
    mocks.functions.on = true;
    mocks.state.disabledMcpConnections = ['docs'];
    const first = render(<ToolsSection />, { wrapper: Wrapper });
    fireEvent.click(toggle(first.container)!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ disabledMcpConnections: ['docs', '_fn'] });
    first.unmount();

    mocks.state.disabledMcpConnections = ['docs', '_fn'];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(toggle(container)!.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle(container)!);
    expect(mocks.useLLM.setState).toHaveBeenLastCalledWith({ disabledMcpConnections: ['docs'] });
  });
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

  it('lists a platform connector switched off until the user switches it on, by id', () => {
    mocks.connections.value = [
      { id: 'p1', ownerType: 'platform', slug: 'shared', displayName: 'Shared docs', urlHost: 'mcp.example.com' },
    ];
    const { container, getByText } = render(<ToolsSection />, { wrapper: Wrapper });

    expect(getByText('Connector set up by an admin on mcp.example.com')).toBeTruthy();
    expect(toggleOf(container, 'shared')!.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggleOf(container, 'shared')!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ enabledPlatformMcpConnections: ['p1'] });
  });

  it('switches a platform connector off again', () => {
    mocks.state.enabledPlatformMcpConnections = ['p1'];
    mocks.connections.value = [
      { id: 'p1', ownerType: 'platform', slug: 'shared', displayName: 'Shared docs', urlHost: 'mcp.example.com' },
    ];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });

    expect(toggleOf(container, 'shared')!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggleOf(container, 'shared')!);
    expect(mocks.useLLM.setState).toHaveBeenCalledWith({ enabledPlatformMcpConnections: [] });
  });

  it('shows a description under the name with the host line below it, and the fixed line when none is set', () => {
    const LONG = 'Searches the team handbook and returns <b>matching</b> pages. https://data.example.com/help';
    mocks.connections.value = [
      { id: 'c1', slug: 'acme', displayName: 'Acme tracker', urlHost: 'mcp.acme.test', description: LONG },
      {
        id: 'p1',
        ownerType: 'platform',
        slug: 'shared',
        displayName: 'Shared docs',
        urlHost: 'mcp.example.com',
        description: 'Company wiki, read only.',
      },
      { id: 'c2', slug: 'docs', displayName: 'Docs', urlHost: 'mcp.docs.test' },
      { id: 'p2', ownerType: 'platform', slug: 'plain', displayName: 'Plain', urlHost: 'plain.example.com' },
    ];
    const { container, getByText, queryByText } = render(<ToolsSection />, { wrapper: Wrapper });
    const rowOf = (slug: string) =>
      container.querySelector(`.tool-item-mcp-connection-${slug} .tool-content`) as HTMLElement;

    const personal = getByText(LONG);
    expect(personal.getAttribute('title')).toBe(LONG);
    expect(personal.querySelector('a, b')).toBeNull();
    expect(rowOf('acme').textContent).toBe(`Acme tracker${LONG}Custom connector on mcp.acme.test`);

    expect(getByText('Company wiki, read only.').getAttribute('title')).toBe('Company wiki, read only.');
    expect(rowOf('shared').textContent).toBe(
      'Shared docsCompany wiki, read only.Set up by an admin on mcp.example.com'
    );
    expect(queryByText('Connector set up by an admin on mcp.example.com')).toBeNull();

    expect(rowOf('docs').textContent).toBe('DocsCustom connector on mcp.docs.test');
    expect(getByText('Custom connector on mcp.docs.test').getAttribute('title')).toBeNull();
    expect(rowOf('plain').textContent).toBe('PlainConnector set up by an admin on plain.example.com');
  });

  it("opens a connector's tools from its row without switching it, and Escape closes them back to the row", async () => {
    const user = userEvent.setup();
    mocks.connections.value = [
      {
        id: 'p1',
        ownerType: 'platform',
        slug: 'shared',
        displayName: 'Shared docs',
        urlHost: 'mcp.example.com',
        tools: [{ name: 'search_pages', description: 'Finds pages.', enabled: true, state: 'active' }],
      },
    ];
    const onModalOpenChange = vi.fn();
    const { container } = render(<ToolsSection onModalOpenChange={onModalOpenChange} />, { wrapper: Wrapper });
    const control = screen.getByRole('button', { name: 'View tools for Shared docs' });

    await user.click(control);
    const dialog = screen.getByRole('dialog', { name: 'Shared docs' });
    expect(within(dialog).getByText('Finds pages.')).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(mocks.useLLM.setState).not.toHaveBeenCalled();
    expect(toggleOf(container, 'shared')!.getAttribute('aria-checked')).toBe('false');
    // The Tools dropdown stays open while the view is.
    expect(onModalOpenChange).toHaveBeenLastCalledWith(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(control);
    expect(onModalOpenChange).toHaveBeenLastCalledWith(false);

    control.blur();
    for (let step = 0; step < 100 && document.activeElement !== control; step++) await user.tab();
    expect(document.activeElement).toBe(control);
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog', { name: 'Shared docs' })).toBeTruthy();
    expect(mocks.useLLM.setState).not.toHaveBeenCalled();
  });

  it('closes the view when its connector drops out of the menu, and does not reopen it when it returns', async () => {
    const shared = {
      id: 'p1',
      ownerType: 'platform',
      slug: 'shared',
      displayName: 'Shared docs',
      urlHost: 'mcp.example.com',
      tools: [{ name: 'search_pages', description: 'Finds pages.', enabled: true, state: 'active' }],
    };
    mocks.connections.value = [shared];
    const { rerender } = render(<ToolsSection />, { wrapper: Wrapper });
    await userEvent.setup().click(screen.getByRole('button', { name: 'View tools for Shared docs' }));
    expect(screen.getByRole('dialog', { name: 'Shared docs' })).toBeTruthy();

    mocks.connections.value = [];
    rerender(<ToolsSection />);
    expect(screen.queryByRole('dialog')).toBeNull();

    mocks.connections.value = [shared];
    rerender(<ToolsSection />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders no connector row when none is offered', () => {
    mocks.connections.value = [];
    const { container } = render(<ToolsSection />, { wrapper: Wrapper });
    expect(container.querySelector('[data-testid^="tool-toggle-mcp-connection-"]')).toBeNull();
  });
});
