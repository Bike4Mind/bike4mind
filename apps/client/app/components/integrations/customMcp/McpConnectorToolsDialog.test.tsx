import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IMcpConnectionPublic, IMcpPlatformConnectionMemberView } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { McpConnectionTool } from './customMcpModel';

vi.mock('@tanstack/react-router', () => ({
  Link: function RouterLink({ to, children, ...rest }: { to: string; children: React.ReactNode }) {
    return (
      <a href={to} {...rest}>
        {children}
      </a>
    );
  },
}));

import McpConnectorToolsDialog from './McpConnectorToolsDialog';

const meta = (...parts: string[]) => parts.join(' \u00b7 ');

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const tool = (overrides: Partial<McpConnectionTool> = {}): McpConnectionTool => ({
  name: 'search',
  description: 'Search',
  descriptionRawHash: 'raw',
  versionHash: 'v1',
  enabled: true,
  approval: 'default',
  state: 'active',
  firstSeenAt: new Date(0),
  ...overrides,
});

const platformConnector = (
  overrides: Partial<IMcpPlatformConnectionMemberView> = {}
): IMcpPlatformConnectionMemberView => ({
  id: 'p1',
  ownerType: 'platform',
  slug: 'shared',
  displayName: 'Shared docs',
  urlHost: 'mcp.example.com',
  status: 'connected',
  enabled: true,
  tools: [],
  ...overrides,
});

const ownConnector = (overrides: Partial<IMcpConnectionPublic> = {}): IMcpConnectionPublic =>
  ({
    id: 'c1',
    ownerType: 'user',
    slug: 'acme',
    displayName: 'Acme tracker',
    urlHost: 'mcp.acme.test',
    status: 'connected',
    enabled: true,
    auth: { kind: 'oauth' },
    tools: [],
    ...overrides,
  }) as IMcpConnectionPublic;

const open = (connection: IMcpConnectionPublic | IMcpPlatformConnectionMemberView) => {
  render(<McpConnectorToolsDialog connection={connection} onClose={vi.fn()} />, { wrapper: Wrapper });
  return screen.getByRole('dialog', { name: connection.displayName });
};

const itemTexts = (dialog: HTMLElement) =>
  within(within(dialog).getByTestId('mcp-connector-tools-list'))
    .getAllByRole('listitem')
    .map(item => item.textContent);

describe('McpConnectorToolsDialog', () => {
  it('lists exactly the tools a platform connector carries, with titles, names, descriptions and hints', () => {
    const dialog = open(
      platformConnector({
        description: 'Company wiki, read only.',
        tools: [
          tool({
            name: 'search_pages',
            title: 'Search pages',
            description: 'Finds pages by keyword and returns the best matches first.',
            annotations: { readOnlyHint: true, openWorldHint: true },
          }),
          tool({
            name: 'update_page',
            description: 'Replaces a page body.',
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
          }),
          tool({ name: 'list_spaces', description: 'Lists every space.', annotations: { title: 'List spaces' } }),
        ],
      })
    );

    expect(within(dialog).getByTestId('mcp-connector-tools-description').textContent).toBe('Company wiki, read only.');
    expect(within(dialog).getByTestId('mcp-connector-tools-meta').textContent).toBe(
      meta('3 tools', 'mcp.example.com', 'Set up by an admin')
    );
    expect(within(dialog).getByTestId('mcp-connector-tools-provenance').textContent).toBe(
      "Descriptions and labels are the server's own claims."
    );
    expect(itemTexts(dialog)).toEqual([
      'Search pagessearch_pagesFinds pages by keyword and returns the best matches first.ReadMay reach other services',
      'update_pageReplaces a page body.WriteMay delete or overwriteServer says it is safe to repeat',
      'List spaceslist_spacesLists every space.Write',
    ]);
    // Under a title the name is a second line, set in the code font.
    const name = within(within(dialog).getByTestId('mcp-connector-tools-tool-search_pages')).getByText('search_pages');
    expect(getComputedStyle(name).fontFamily).toContain('code');
    expect(within(dialog).queryByTestId('mcp-connector-tools-others')).toBeNull();
    expect(within(dialog).queryByText(/more tool/)).toBeNull();
    expect(within(dialog).queryByRole('textbox')).toBeNull();
  });

  it("lists only the user's own enabled, reviewed tools and counts the rest with a link to manage them", () => {
    const dialog = open(
      ownConnector({
        tools: [
          tool({ name: 'create_issue', description: 'Opens an issue.' }),
          tool({ name: 'close_issue', enabled: false, description: 'Closes an issue.' }),
          tool({ name: 'list_issues', description: 'Lists issues.', annotations: { readOnlyHint: true } }),
          tool({ name: 'new_tool', state: 'pending_review', description: 'Not reviewed yet.' }),
          tool({ name: 'off_and_new', state: 'pending_review', enabled: false, description: 'Neither.' }),
        ],
      })
    );

    expect(itemTexts(dialog)).toEqual(['create_issueOpens an issue.Write', 'list_issuesLists issues.Read']);
    expect(within(dialog).getByTestId('mcp-connector-tools-meta').textContent).toBe(
      meta('2 tools', 'mcp.acme.test', 'Your connector')
    );
    expect(within(dialog).getByTestId('mcp-connector-tools-others').textContent).toBe(
      '3 more tools are switched off or waiting for review. Manage in Integrations'
    );
    expect(within(dialog).getByRole('link', { name: 'Manage in Integrations' }).getAttribute('href')).toBe(
      '/integrations'
    );
  });

  it('says one more tool in the singular, and nothing when every tool is offered', () => {
    const { unmount } = render(
      <McpConnectorToolsDialog
        connection={ownConnector({ tools: [tool({ name: 'a' }), tool({ name: 'b', enabled: false })] })}
        onClose={vi.fn()}
      />,
      { wrapper: Wrapper }
    );
    expect(screen.getByTestId('mcp-connector-tools-others').textContent).toBe(
      '1 more tool is switched off or waiting for review. Manage in Integrations'
    );
    expect(screen.getByTestId('mcp-connector-tools-meta').textContent).toBe(
      meta('1 tool', 'mcp.acme.test', 'Your connector')
    );
    unmount();

    const dialog = open(ownConnector({ tools: [tool({ name: 'a' })] }));
    expect(within(dialog).queryByTestId('mcp-connector-tools-others')).toBeNull();
  });

  it('renders markup, Markdown and URLs in a description as plain text', () => {
    const CONNECTOR = 'Searches <b>handbook</b> pages. See **docs** at https://data.example.com/help';
    const TOOL = '<img src="x" onerror="alert(1)"> [Open](https://data.example.com/tools) <a href="#">here</a>';
    const dialog = open(
      platformConnector({
        description: CONNECTOR,
        tools: [tool({ name: 'lookup', title: '<i>Lookup</i>', description: TOOL })],
      })
    );

    expect(within(dialog).getByTestId('mcp-connector-tools-description').textContent).toBe(CONNECTOR);
    expect(within(dialog).getByText(TOOL)).toBeTruthy();
    expect(within(dialog).getByText('<i>Lookup</i>')).toBeTruthy();
    expect(dialog.querySelector('a, b, i, img, strong')).toBeNull();
  });

  it('shows the filter only past ten tools and narrows by title, name and description', () => {
    const tools = [
      tool({ name: 'wx_fetch', title: 'Weather report', description: 'Forecast for a city.' }),
      tool({ name: 'geo_lookup', description: 'Coordinates for an address.' }),
      tool({ name: 'billing_sync', description: 'Copies every invoice to the ledger.' }),
      ...Array.from({ length: 7 }, (_, i) => tool({ name: `filler_${i}`, description: `Filler ${i}.` })),
    ];
    const { unmount } = render(
      <McpConnectorToolsDialog connection={platformConnector({ tools })} onClose={vi.fn()} />,
      { wrapper: Wrapper }
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByRole('textbox', { name: 'Filter tools' })).toBeNull();
    unmount();

    const dialog = open(platformConnector({ tools: [...tools, tool({ name: 'filler_7', description: 'Filler 7.' })] }));
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(11);
    const filter = within(dialog).getByRole('textbox', { name: 'Filter tools' });
    const shown = () =>
      within(dialog)
        .queryAllByRole('listitem')
        .map(item => item.getAttribute('data-testid'));

    fireEvent.change(filter, { target: { value: 'WEATHER' } });
    expect(shown()).toEqual(['mcp-connector-tools-tool-wx_fetch']);
    fireEvent.change(filter, { target: { value: 'geo_look' } });
    expect(shown()).toEqual(['mcp-connector-tools-tool-geo_lookup']);
    fireEvent.change(filter, { target: { value: 'invoice' } });
    expect(shown()).toEqual(['mcp-connector-tools-tool-billing_sync']);
    expect(within(dialog).getByTestId('mcp-connector-tools-meta').textContent).toBe(
      meta('11 tools', 'mcp.example.com', 'Set up by an admin')
    );

    fireEvent.change(filter, { target: { value: 'no such tool' } });
    expect(shown()).toEqual([]);
    expect(within(dialog).getByTestId('mcp-connector-tools-no-match').textContent).toBe('No tools match this filter.');

    fireEvent.change(filter, { target: { value: '' } });
    expect(shown()).toHaveLength(11);
  });

  it('keeps an active filter editable when refreshed tools fall below the filter threshold', () => {
    const tools = Array.from({ length: 10 }, (_, index) => tool({ name: `filler_${index}` }));
    const onClose = vi.fn();
    const { rerender } = render(
      <McpConnectorToolsDialog
        connection={platformConnector({ tools: [...tools, tool({ name: 'weather' })] })}
        onClose={onClose}
      />,
      { wrapper: Wrapper }
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter tools' }), { target: { value: 'weather' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);

    rerender(<McpConnectorToolsDialog connection={platformConnector({ tools })} onClose={onClose} />);

    expect(screen.getByTestId('mcp-connector-tools-no-match')).toBeTruthy();
    const filter = screen.getByRole('textbox', { name: 'Filter tools' });
    expect((filter as HTMLInputElement).value).toBe('weather');
    fireEvent.change(filter, { target: { value: '' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByRole('textbox', { name: 'Filter tools' })).toBeNull();
  });

  it('says a tool has no description, and shows nothing for a connector without one', () => {
    const dialog = open(platformConnector({ tools: [tool({ name: 'ping', description: '' })] }));

    expect(itemTexts(dialog)).toEqual(['pingNo description from the server.Write']);
    expect(within(dialog).queryByTestId('mcp-connector-tools-description')).toBeNull();
    const title = within(dialog).getByText('Shared docs');
    expect(title.nextElementSibling).toBe(within(dialog).getByTestId('mcp-connector-tools-meta'));
  });
});
