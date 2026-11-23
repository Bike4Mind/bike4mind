import React from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '../../../utils/themes';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const state = { guard: true, menuKeys: [] as string[] };

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/integrations">{children}</a>,
}));

const CONNECTION = {
  id: 'p1',
  ownerType: 'platform',
  slug: 'shared',
  displayName: 'Shared docs',
  urlHost: 'mcp.example.com',
  status: 'connected',
  enabled: true,
  tools: Array.from({ length: 12 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool ${i}.`,
    descriptionRawHash: 'h',
    enabled: true,
    approval: 'default',
    state: 'active',
    firstSeenAt: new Date(0),
  })),
};

// A stand-in with ToolsSection's open-state and onModalOpenChange wiring around the real dialog,
// inside the real Joy Menu that ToolsButton renders.
vi.mock('./ToolsSection', async () => {
  const { useEffect, useState } = await import('react');
  const { default: Dialog } = await import('@client/app/components/integrations/customMcp/McpConnectorToolsDialog');
  return {
    default: function ToolsSectionStandIn({ onModalOpenChange }: { onModalOpenChange?: (open: boolean) => void }) {
      const [open, setOpen] = useState(false);
      useEffect(() => {
        if (state.guard) onModalOpenChange?.(open);
      }, [open, onModalOpenChange]);
      return (
        <div onKeyDown={event => state.menuKeys.push(event.key)}>
          <button type="button" onClick={() => setOpen(true)}>
            View tools for Shared docs
          </button>
          <Dialog connection={open ? (CONNECTION as never) : null} onClose={() => setOpen(false)} />
        </div>
      );
    },
  };
});
vi.mock('../../common/ToolIndicators', async importOriginal => ({
  default: () => <div data-testid="tool-indicators" />,
  ICONED_MCP_SERVERS: ['github', 'atlassian'],
  AGENT_ONLY_MCP_SERVERS: ['github', 'atlassian'],
  hasToolIndicators: (await importOriginal<typeof import('../../common/ToolIndicators')>()).hasToolIndicators,
}));
vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ data: [{ id: 'gpt-4o', name: 'GPT-4o', supportsTools: true }] }),
}));

import ToolsButton from './ToolsButton';

const props = {
  isMobile: false,
  isTablet: false,
  tools: [] as never[],
  toolMode: 'smart',
  onRollDice: vi.fn(),
  activePrimaryTools: [],
  isThinkingActive: false,
  otherActiveToolsCount: 0,
  enabledMcpServers: null,
  availableMcpServers: [] as string[],
  setTools: vi.fn(),
  model: 'gpt-4o',
};

// ToolsButton focuses the menu 100 ms after it opens.
const settle = () => act(() => new Promise(resolve => setTimeout(resolve, 200)));

async function openDialog() {
  const user = userEvent.setup();
  render(
    <TestWrapper>
      <ToolsButton {...(props as never)} />
    </TestWrapper>
  );
  await user.click(screen.getByTestId('session-tools-dropdown-toggle'));
  await settle();
  await user.click(screen.getByRole('button', { name: 'View tools for Shared docs' }));
  await settle();
  return user;
}

describe('ToolsButton - a connector tool view opened from the menu', () => {
  beforeEach(() => {
    state.menuKeys.length = 0;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it('keeps the menu open behind it, keeps keys out of the menu list, and Escape closes only the view', async () => {
    state.guard = true;
    const user = await openDialog();
    expect(screen.queryByRole('dialog', { name: 'Shared docs' })).not.toBeNull();
    // The open Modal hides the menu from the accessibility tree, so look it up by text.
    expect(screen.queryByText('View tools for Shared docs')).not.toBeNull();

    const filter = screen.getByRole('textbox', { name: 'Filter tools' });
    await user.click(filter);
    await user.keyboard('ab{Home}c{End}d{ArrowLeft}{ArrowDown}');
    expect((filter as HTMLInputElement).value).toBe('cabd');
    expect(state.menuKeys).toEqual([]);
    await user.tab();
    expect(screen.getByRole('dialog', { name: 'Shared docs' }).contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    await settle();
    expect(screen.queryByRole('dialog', { name: 'Shared docs' })).toBeNull();
    expect(screen.queryByRole('menu')).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View tools for Shared docs' }));
  });

  it('closes with the menu when the open view is not reported', async () => {
    state.guard = false;
    await openDialog();
    expect(screen.queryByRole('dialog', { name: 'Shared docs' })).toBeNull();
  });
});
