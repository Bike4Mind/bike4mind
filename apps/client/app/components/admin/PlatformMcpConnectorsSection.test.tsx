import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';

const h = vi.hoisted(() => ({
  confirm: vi.fn(),
  impersonating: false,
  featureOn: true,
  settingsLoaded: true,
  currentUser: { isAdmin: true } as { isAdmin: boolean; adminPermissions?: string[] },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: h.currentUser }) }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (s: { impersonating: boolean }) => unknown) =>
    selector({ impersonating: h.impersonating }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => h.confirm }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => h.featureOn, authedSettingsLoaded: h.settingsLoaded }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import PlatformMcpConnectorsSection from './PlatformMcpConnectorsSection';
import McpConnectionItem from '@client/app/components/integrations/customMcp/McpConnectionItem';
import AddMcpConnectorForm from '@client/app/components/integrations/customMcp/AddMcpConnectorForm';
import {
  mcpConnectionKeys,
  useRefreshMcpConnectionTools,
  useUpdateMcpConnection,
} from '@client/app/hooks/data/mcpConnections';

const appTheme = extendTheme({ ...getThemeConfig() });
const LIST_URL = '/api/admin/mcp-connections';
const USER_URL = '/api/mcp-connections';
const KEY_LAST4 = 'wxyz';
const READ_ONLY_ADMIN = { isAdmin: false, adminPermissions: ['support:read'] };
const MISSING = 'Missing permission: settings:manage';

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

const wrap = (node: React.ReactNode, queryClient = newClient()) =>
  render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{node}</CssVarsProvider>
    </QueryClientProvider>
  );
const renderSection = () => wrap(<PlatformMcpConnectorsSection />);

const tool = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  description: `${name} things`,
  descriptionRawHash: 'raw',
  versionHash: `v-${name}`,
  enabled: false,
  approval: 'default',
  state: 'pending_review',
  firstSeenAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
});

const connection = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'p1',
    ownerType: 'platform',
    userId: 'admin-1',
    slug: 'example_docs',
    displayName: 'Example connector',
    displayUrl: 'https://mcp.example.com/mcp',
    urlHost: 'mcp.example.com',
    transport: 'auto',
    auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: KEY_LAST4 } },
    status: 'connected',
    tools: [
      tool('search', { enabled: true, state: 'active', annotations: { readOnlyHint: true } }),
      tool('create_page', { enabled: false, state: 'active' }),
    ],
    enabled: true,
    lastUsedAt: '2026-11-10T12:00:00.000Z',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as IMcpConnectionPublic;

const listReturns = (connections: IMcpConnectionPublic[]) =>
  vi
    .mocked(api.get)
    .mockImplementation((url: string) =>
      url === LIST_URL ? Promise.resolve({ data: connections }) : Promise.reject(new Error(`unexpected GET ${url}`))
    );

const httpError = (status: number, data: Record<string, unknown>) =>
  Object.assign(new Error(String(status)), { isAxiosError: true, response: { status, data } });

const RATE_LIMITED = { error: 'Rate limit exceeded. Try again in 120 seconds.' };

// Per-keystroke input is not under test here; pasting fills a field in one change event.
const fill = async (field: HTMLElement, text: string) => {
  await userEvent.click(field);
  await userEvent.paste(text);
};

const openMenu = async (id = 'p1') => {
  await userEvent.click(await screen.findByTestId(`platform-mcp-row-actions-${id}`));
  return screen.findByRole('menu');
};
const pick = async (action: string, id = 'p1') => {
  await openMenu(id);
  await userEvent.click(screen.getByTestId(`platform-mcp-${action}-${id}`));
};
const reasonOn = (element: HTMLElement) =>
  element.closest('[data-testid="admin-missing-permission-action"]')?.getAttribute('aria-label');
const sentAnything = () => [api.post, api.patch, api.delete].some(fn => vi.mocked(fn).mock.calls.length > 0);
const menuItems = (menu: HTMLElement) =>
  Array.from(menu.querySelectorAll('[role="menuitem"]'), item => item.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  // Also drops queued one-off answers a failed test left unused.
  [api.get, api.post, api.patch, api.delete].forEach(fn => vi.mocked(fn).mockReset());
  h.confirm.mockImplementation(({ onOk }: { onOk: () => void }) => onOk());
  h.impersonating = false;
  h.featureOn = true;
  h.settingsLoaded = true;
  h.currentUser = { isAdmin: true };
});

describe('PlatformMcpConnectorsSection', () => {
  describe('the table', () => {
    it('shows each connector as a row with status, host, authentication, tools offered and last use', async () => {
      listReturns([
        connection(),
        connection({
          id: 'p2',
          displayName: 'Open connector',
          urlHost: 'open.example.com',
          auth: { kind: 'none' },
          enabled: false,
          tools: [tool('status', { enabled: true, state: 'active' }), tool('open_incident')],
        }),
        connection({ id: 'p3', displayName: 'Broken connector', status: 'needs_reconnect', lastUsedAt: undefined }),
      ]);
      renderSection();

      const first = await screen.findByTestId('platform-mcp-row-p1');
      const section = screen.getByTestId('platform-mcp-section');
      expect(within(section).getByRole('heading', { level: 2 })).toHaveTextContent('Platform connectors (3)');
      expect(section).toHaveTextContent(
        "A platform connector appears in every user's Tools menu switched off, and nothing of it reaches a chat until that user turns it on."
      );
      expect(within(first).getByText('Example connector')).toBeInTheDocument();
      expect(within(first).getByTestId('platform-mcp-status-p1')).toHaveTextContent('Connected');
      expect(within(first).getByTestId('platform-mcp-host-p1')).toHaveTextContent('mcp.example.com');
      expect(first).toHaveTextContent('API key');
      expect(within(first).getByTestId('platform-mcp-tools-p1')).toHaveTextContent(/^1 of 2 tools offered to users$/);
      expect(within(first).getByTestId('platform-mcp-last-used-p1')).toHaveAttribute(
        'datetime',
        '2026-11-10T12:00:00.000Z'
      );
      expect(within(first).queryByTestId('platform-mcp-disabled-p1')).not.toBeInTheDocument();

      const second = screen.getByTestId('platform-mcp-row-p2');
      expect(second).toHaveTextContent('No authentication');
      expect(within(second).getByTestId('platform-mcp-disabled-p2')).toHaveTextContent('Disabled');
      expect(within(second).getByTestId('platform-mcp-tools-p2')).toHaveTextContent(
        'Not offered to users1 waiting for review'
      );
      expect(within(second).getByTestId('platform-mcp-status-p2')).toHaveTextContent('Pending review');

      const third = screen.getByTestId('platform-mcp-row-p3');
      expect(within(third).getByTestId('platform-mcp-status-p3')).toHaveTextContent('Key refused');
      expect(within(third).getByTestId('platform-mcp-detail-p3')).toHaveTextContent(
        'Replace the API key to reconnect.'
      );
      expect(within(third).getByLabelText('Never used')).toBeInTheDocument();

      expect(screen.getByTestId('platform-mcp-table')).not.toHaveTextContent(KEY_LAST4);
      expect(document.body.textContent).not.toContain('/mcp');
    });

    it('counts the tools offered only on a connected connector that is on, and says none are offered otherwise', async () => {
      listReturns([
        connection(),
        connection({ id: 'p2', status: 'error', lastError: { message: 'The server did not respond' } }),
        connection({ id: 'p3', enabled: false }),
      ]);
      renderSection();

      expect(await screen.findByTestId('platform-mcp-tools-p1')).toHaveTextContent(/^1 of 2 tools offered to users$/);
      expect(screen.getByTestId('platform-mcp-tools-p2')).toHaveTextContent(/^Not offered to users$/);
      expect(screen.getByTestId('platform-mcp-tools-p3')).toHaveTextContent(/^Not offered to users$/);
    });

    it('keeps text actions in one row menu, Remove last after a divider', async () => {
      listReturns([connection()]);
      renderSection();

      const menu = await openMenu();
      expect(menuItems(menu)).toEqual([
        'Review tools',
        'Edit details',
        'Refresh tools',
        'Replace API key',
        'Turn off for all users',
        'Remove',
      ]);
      expect(within(menu).getByRole('separator')).toBeInTheDocument();
      expect(screen.getByTestId('platform-mcp-row-p1').querySelectorAll('button')).toHaveLength(1);
    });

    it('shows a plain empty state with a way to add the first connector', async () => {
      listReturns([]);
      renderSection();

      const empty = await screen.findByTestId('admin-empty-state');
      expect(empty).toHaveTextContent('No platform connectors yet');
      expect(empty).toHaveTextContent("Add one to list it in every user's Tools menu.");
      await userEvent.click(within(empty).getByTestId('platform-mcp-add-btn'));
      expect(screen.getByTestId('custom-mcp-add-form')).toBeInTheDocument();
    });

    it('shows a loading state, then an error state that retries', async () => {
      let fail: (error: Error) => void = () => undefined;
      vi.mocked(api.get).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      renderSection();

      expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
      fail(new Error('boom'));
      const error = await screen.findByTestId('admin-error-state');
      expect(error).toHaveTextContent('Could not load the platform connectors.');

      listReturns([connection()]);
      await userEvent.click(within(error).getByTestId('admin-error-retry-btn'));
      expect(await screen.findByTestId('platform-mcp-row-p1')).toBeInTheDocument();
    });

    it('says so instead of loading forever while impersonating, and asks for nothing', () => {
      h.impersonating = true;
      renderSection();

      expect(screen.getByTestId('platform-mcp-impersonating')).toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalled();
    });

    it('shows a blocked connector with the connector-policy wording, not the personal one', async () => {
      listReturns([connection({ status: 'blocked_by_policy' })]);
      renderSection();

      expect(await screen.findByTestId('platform-mcp-detail-p1')).toHaveTextContent('Blocked by the connector policy.');
      expect(document.body.textContent).not.toContain("Your organization's connector policy");
      const menu = await openMenu();
      expect(within(menu).getByTestId('platform-mcp-toggle-p1')).toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('a connector the server refuses', () => {
    it('offers no sign-in on a connector without authentication and sends nothing to the user routes', async () => {
      listReturns([connection({ auth: { kind: 'none' }, status: 'needs_reconnect' })]);
      renderSection();

      expect(await screen.findByTestId('platform-mcp-status-p1')).toHaveTextContent('Server requires authentication');
      expect(screen.getByTestId('platform-mcp-detail-p1')).toHaveTextContent(
        'Remove it and add it again with an API key.'
      );
      const menu = await openMenu();
      expect(menuItems(menu)).toEqual(['Edit details', 'Refresh tools', 'Turn off for all users', 'Remove']);
      expect(document.body.textContent).not.toMatch(/Sign in|Reconnect/);

      await userEvent.click(within(menu).getByTestId('platform-mcp-refresh-p1'));
      const urls = [api.get, api.post, api.patch, api.delete].flatMap(fn =>
        vi.mocked(fn).mock.calls.map(call => String(call[0]))
      );
      expect(urls.filter(url => url.startsWith(USER_URL))).toEqual([]);
    });

    it('offers no sign-in on a connector still waiting for authentication', async () => {
      listReturns([connection({ auth: { kind: 'none' }, status: 'pending_auth' })]);
      renderSection();

      const menu = await openMenu();
      expect(menuItems(menu)).toEqual(['Edit details', 'Turn off for all users', 'Remove']);
    });
  });

  describe('feature settings off', () => {
    it('says what users and admins lose, and disables Add, Refresh tools and Replace API key with the reason', async () => {
      h.featureOn = false;
      listReturns([connection()]);
      renderSection();

      expect(await screen.findByTestId('platform-mcp-feature-off')).toHaveTextContent(
        'Users see no platform connectors while Enable MCP Server or Enable Custom MCP Connectors is off in Admin settings, and connectors cannot be added, refreshed or given a new key.'
      );
      const add = await screen.findByTestId('platform-mcp-add-btn');
      expect(add).toBeDisabled();
      expect(reasonOn(add)).toMatch(/Enable MCP Server and Enable Custom MCP Connectors/);

      const menu = await openMenu();
      for (const action of ['refresh', 'api-key']) {
        const item = within(menu).getByTestId(`platform-mcp-${action}-p1`);
        expect(item).toHaveAttribute('aria-disabled', 'true');
        expect(reasonOn(item)).toMatch(/Enable MCP Server and Enable Custom MCP Connectors/);
      }
      expect(within(menu).getByTestId('platform-mcp-toggle-p1')).not.toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(within(menu).getByTestId('platform-mcp-refresh-p1'));
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows neither the note nor a disabled Add connector before the signed-in settings arrive', async () => {
      h.featureOn = false;
      h.settingsLoaded = false;
      listReturns([connection()]);
      renderSection();

      await screen.findByTestId('platform-mcp-row-p1');
      expect(screen.queryByTestId('platform-mcp-feature-off')).not.toBeInTheDocument();
      expect(screen.getByTestId('platform-mcp-add-btn')).toBeEnabled();
    });
  });

  describe('an admin who can read but not manage settings', () => {
    it('sees every write disabled with the reason and can still read the tool review, sending nothing', async () => {
      h.currentUser = READ_ONLY_ADMIN;
      listReturns([connection({ tools: [tool('search'), tool('create_page', { enabled: true, state: 'active' })] })]);
      renderSection();

      const add = await screen.findByTestId('platform-mcp-add-btn');
      expect(add).toBeDisabled();
      expect(reasonOn(add)).toBe(MISSING);

      const menu = await openMenu();
      for (const action of ['edit', 'refresh', 'api-key', 'toggle', 'remove']) {
        const item = within(menu).getByTestId(`platform-mcp-${action}-p1`);
        expect(item).toHaveAttribute('aria-disabled', 'true');
        expect(reasonOn(item)).toBe(MISSING);
        fireEvent.click(item);
      }
      const review = within(menu).getByTestId('platform-mcp-review-p1');
      expect(review).not.toHaveAttribute('aria-disabled', 'true');
      await userEvent.click(review);

      const dialog = await screen.findByTestId('platform-mcp-review-dialog');
      expect(within(dialog).getByText('search things')).toBeInTheDocument();
      const save = within(dialog).getByTestId('custom-mcp-review-p1-save-btn');
      expect(save).toBeDisabled();
      expect(within(dialog).getByTestId('custom-mcp-review-p1-tool-search-switch')).toBeDisabled();
      expect(within(dialog).getByTestId('custom-mcp-review-p1-tool-create_page-approval')).toBeDisabled();
      const locked = within(dialog).getAllByTestId('mcp-review-locked');
      expect(locked).toHaveLength(5);
      locked.forEach(wrapper => {
        expect(wrapper).toHaveAttribute('aria-label', MISSING);
        expect(wrapper).toHaveAttribute('tabindex', '0');
      });
      fireEvent.click(save);
      expect(sentAnything()).toBe(false);
      expect(screen.queryByTestId('platform-mcp-api-key-dialog')).not.toBeInTheDocument();
      expect(screen.queryByTestId('platform-mcp-remove-dialog')).not.toBeInTheDocument();
      expect(screen.queryByTestId('platform-mcp-details-dialog')).not.toBeInTheDocument();
    });
  });

  describe('adding a connector', () => {
    const fillForm = async () => {
      await userEvent.click(await screen.findByTestId('platform-mcp-add-btn'));
      await fill(screen.getByTestId('custom-mcp-add-name-input'), 'Example connector');
      await fill(screen.getByTestId('custom-mcp-add-url-input'), 'https://mcp.example.com/mcp');
      await fill(screen.getByTestId('custom-mcp-add-api-key-input'), 'example-key-0123456789');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));
    };

    it('opens above the table with focus in Name, offers an API key or no authentication, and posts to the admin route', async () => {
      listReturns([connection({ id: 'p0', displayName: 'Existing' })]);
      const created = connection({ tools: [tool('search'), tool('create_page')] });
      vi.mocked(api.post).mockResolvedValueOnce({ data: created });
      renderSection();

      await userEvent.click(await screen.findByTestId('platform-mcp-add-btn'));
      const form = screen.getByTestId('platform-mcp-add');
      expect(
        form.compareDocumentPosition(screen.getByTestId('platform-mcp-table')) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(screen.getByTestId('custom-mcp-add-name-input')).toHaveFocus();
      expect(screen.getByTestId('custom-mcp-add-auth-api_key')).toBeChecked();
      expect(screen.getByTestId('custom-mcp-add-auth-none')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-auth-oauth')).not.toBeInTheDocument();
      expect(screen.getByTestId('custom-mcp-add-warning')).toHaveTextContent(
        'Bike4Mind has not reviewed this server. Any user who switches it on can use its tools, and every call uses the authentication set here. Tool descriptions come from the server.'
      );
      await userEvent.click(screen.getByTestId('custom-mcp-add-cancel-btn'));
      await waitFor(() => expect(screen.getByTestId('platform-mcp-add-btn')).toHaveFocus());
      await fillForm();

      expect(api.post).toHaveBeenCalledWith(LIST_URL, {
        url: 'https://mcp.example.com/mcp',
        displayName: 'Example connector',
        transport: 'auto',
        auth: { kind: 'api_key', value: 'example-key-0123456789', headerName: 'Authorization', scheme: 'Bearer' },
      });
      const dialog = await screen.findByTestId('platform-mcp-review-dialog');
      expect(within(dialog).getByTestId('custom-mcp-review-p1')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-form')).not.toBeInTheDocument();
    });

    it("announces the server's validation error and keeps the form", async () => {
      listReturns([]);
      vi.mocked(api.post).mockRejectedValueOnce(
        httpError(400, { error: 'Invalid request body', issues: [{ message: 'Use an https address.' }] })
      );
      renderSection();

      await fillForm();

      const error = await screen.findByTestId('custom-mcp-add-error');
      expect(error).toHaveAttribute('role', 'alert');
      expect(error).toHaveTextContent('Use an https address.');
      expect(screen.getByTestId('custom-mcp-add-form')).toBeInTheDocument();
    });

    it('shows a rate-limited create as a plain message', async () => {
      listReturns([]);
      vi.mocked(api.post).mockRejectedValueOnce(httpError(429, RATE_LIMITED));
      renderSection();

      await fillForm();

      expect(await screen.findByTestId('custom-mcp-add-error')).toHaveTextContent(RATE_LIMITED.error);
      expect(screen.getByTestId('custom-mcp-add-form')).toBeInTheDocument();
    });

    it('sends the description written on the add form, trimmed', async () => {
      listReturns([]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: connection({ description: 'Searches the team handbook.' }) });
      renderSection();

      await userEvent.click(await screen.findByTestId('platform-mcp-add-btn'));
      expect(screen.getByTestId('platform-mcp-add')).toHaveTextContent(
        'Users offered this connector see it under the name in their Tools menu. One paragraph of plain text: line breaks and <tags> are removed. 0/300'
      );
      await fill(screen.getByTestId('custom-mcp-add-description-input'), '  Searches the team handbook.  ');
      await fill(screen.getByTestId('custom-mcp-add-name-input'), 'Example connector');
      await fill(screen.getByTestId('custom-mcp-add-url-input'), 'https://mcp.example.com/mcp');
      await fill(screen.getByTestId('custom-mcp-add-api-key-input'), 'example-key-0123456789');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));

      expect(api.post).toHaveBeenCalledWith(
        LIST_URL,
        expect.objectContaining({ displayName: 'Example connector', description: 'Searches the team handbook.' })
      );
    });
  });

  describe('editing details', () => {
    const DESCRIBED = connection({ description: 'Searches the team handbook.' });

    it('edits the name and description together in a dialog and sends only what changed', async () => {
      listReturns([DESCRIBED]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: { ...DESCRIBED, description: 'Reads the handbook.' } });
      renderSection();

      await pick('edit');
      const dialog = await screen.findByTestId('platform-mcp-details-dialog');
      expect(within(dialog).getByTestId('platform-mcp-details-name-input')).toHaveValue('Example connector');
      const field = within(dialog).getByTestId('platform-mcp-details-description-input');
      expect(field).toHaveValue('Searches the team handbook.');
      expect(field).toHaveAttribute('maxlength', '300');
      await userEvent.clear(field);
      await fill(field, 'Reads the handbook.');
      await userEvent.click(within(dialog).getByTestId('platform-mcp-details-save-btn'));

      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p1`, { description: 'Reads the handbook.' });
      await waitFor(() => expect(screen.queryByTestId('platform-mcp-details-dialog')).not.toBeInTheDocument());
      expect(toast.success).toHaveBeenCalledWith('Details saved.');
      await waitFor(() => expect(screen.getByTestId('platform-mcp-row-actions-p1')).toHaveFocus());
    });

    it('clears the description by sending an empty one, and sends nothing when nothing changed', async () => {
      listReturns([DESCRIBED]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: { ...DESCRIBED, description: undefined } });
      renderSection();

      await pick('edit');
      await userEvent.click(await screen.findByTestId('platform-mcp-details-save-btn'));
      expect(api.patch).not.toHaveBeenCalled();
      expect(screen.queryByTestId('platform-mcp-details-dialog')).not.toBeInTheDocument();

      await pick('edit');
      await userEvent.clear(await screen.findByTestId('platform-mcp-details-description-input'));
      await userEvent.click(screen.getByTestId('platform-mcp-details-save-btn'));
      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p1`, { description: '' });
    });

    it('shows a failed save as the error state in the dialog, keeps the text, and saves again on Try again', async () => {
      listReturns([DESCRIBED]);
      vi.mocked(api.patch)
        .mockRejectedValueOnce(
          httpError(400, {
            error: 'Invalid request body',
            issues: [{ path: 'description', message: 'Description must be at most 300 characters' }],
          })
        )
        .mockResolvedValueOnce({ data: { ...DESCRIBED, description: 'Reads the handbook.' } });
      renderSection();

      await pick('edit');
      const field = await screen.findByTestId('platform-mcp-details-description-input');
      await userEvent.clear(field);
      await fill(field, 'Reads the handbook.');
      await userEvent.click(screen.getByTestId('platform-mcp-details-save-btn'));

      const error = await screen.findByTestId('admin-error-state');
      expect(error).toHaveAttribute('role', 'alert');
      expect(error).toHaveTextContent('Description must be at most 300 characters');
      expect(within(screen.getByTestId('platform-mcp-details-dialog')).getByTestId('admin-error-state')).toBe(error);
      expect(field).toHaveValue('Reads the handbook.');
      expect(toast.success).not.toHaveBeenCalled();

      await userEvent.click(within(error).getByTestId('admin-error-retry-btn'));
      expect(api.patch).toHaveBeenCalledTimes(2);
      expect(api.patch).toHaveBeenLastCalledWith(`${LIST_URL}/p1`, { description: 'Reads the handbook.' });
      await waitFor(() => expect(screen.queryByTestId('platform-mcp-details-dialog')).not.toBeInTheDocument());
    });
  });

  describe('managing a connector', () => {
    it('approves one tool and disables another in a dialog, through the admin route', async () => {
      const current = connection({ tools: [tool('search'), tool('create_page', { enabled: true, state: 'active' })] });
      listReturns([current]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: current });
      renderSection();

      await pick('review');
      const review = within(await screen.findByTestId('platform-mcp-review-dialog')).getByTestId(
        'custom-mcp-review-p1'
      );
      expect(within(review).getByText('search things')).toBeInTheDocument();
      await userEvent.click(within(review).getByTestId('custom-mcp-review-p1-tool-search-switch'));
      await userEvent.click(within(review).getByTestId('custom-mcp-review-p1-tool-create_page-switch'));
      await userEvent.click(within(review).getByTestId('custom-mcp-review-p1-save-btn'));

      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p1`, {
        tools: [
          { name: 'search', versionHash: 'v-search', enabled: true, approval: 'default', state: 'active' },
          { name: 'create_page', versionHash: 'v-create_page', enabled: false, approval: 'default', state: 'active' },
        ],
      });
      await waitFor(() => expect(screen.queryByTestId('platform-mcp-review-dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('platform-mcp-row-actions-p1')).toHaveFocus());
    });

    it('says what Always allow means on a write tool and offers no Ask for writes on a read-only one', async () => {
      listReturns([connection()]);
      renderSection();

      await pick('review');
      const dialog = await screen.findByTestId('platform-mcp-review-dialog');
      expect(within(dialog).getByTestId('custom-mcp-review-p1-tool-create_page-approval-note')).toHaveTextContent(
        'Always allow lets every user who turned this connector on run this tool without being asked.'
      );
      expect(within(dialog).queryByTestId('custom-mcp-review-p1-tool-search-approval-note')).not.toBeInTheDocument();

      const readOnly = within(dialog).getByTestId('custom-mcp-review-p1-tool-search-approval');
      expect(readOnly).toHaveTextContent('Always allow');
      await userEvent.click(readOnly);
      expect(
        screen.getAllByRole('option').map(option => option.textContent),
        'read-only tool'
      ).toEqual(['Always allow', 'Always ask']);
    });

    it('re-reads the platform list, not the personal one, when the server changed the tools during review', async () => {
      listReturns([connection()]);
      vi.mocked(api.patch).mockRejectedValueOnce(httpError(409, { code: 'tool_version_conflict' }));
      renderSection();

      await pick('review');
      await userEvent.click(await screen.findByTestId('custom-mcp-review-p1-save-btn'));

      await waitFor(() =>
        expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === LIST_URL).length).toBeGreaterThan(1)
      );
      expect(vi.mocked(api.get).mock.calls.filter(([url]) => url === USER_URL)).toEqual([]);
      expect(toast.error).toHaveBeenCalledWith(
        'The server changed its tools while you were reviewing. Review them again.'
      );
    });

    it('refreshes the tool list from the server and opens what needs review', async () => {
      listReturns([connection()]);
      vi.mocked(api.post).mockResolvedValueOnce({
        data: {
          connection: connection({ tools: [tool('added')] }),
          discovery: { added: ['added'], changed: [], removed: [], dropped: 0 },
        },
      });
      renderSection();

      await pick('refresh');

      expect(api.post).toHaveBeenCalledWith(`${LIST_URL}/p1/refresh-tools`);
      expect(await screen.findByTestId('custom-mcp-review-p1-tool-added')).toBeInTheDocument();
    });

    it('replaces the API key in a dialog that names the key it replaces and never echoes the new one', async () => {
      listReturns([connection({ status: 'needs_reconnect' })]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: connection() });
      renderSection();

      await pick('api-key');
      const dialog = await screen.findByTestId('platform-mcp-api-key-dialog');
      expect(dialog).toHaveTextContent(`Replace API key for Example connector`);
      expect(within(dialog).getByTestId('platform-mcp-api-key-hint')).toHaveTextContent(
        `Replaces the key ending ${KEY_LAST4}.`
      );
      const input = within(dialog).getByTestId('platform-mcp-api-key-input');
      expect(input).toHaveAttribute('type', 'password');
      await fill(input, 'rotated-key-0123456789');
      await userEvent.click(within(dialog).getByTestId('platform-mcp-api-key-save-btn'));

      expect(api.post).toHaveBeenCalledWith(`${LIST_URL}/p1/api-key`, { value: 'rotated-key-0123456789' });
      await waitFor(() => expect(screen.getByTestId('platform-mcp-status-p1')).toHaveTextContent('Connected'));
      expect(screen.queryByTestId('platform-mcp-api-key-dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId('platform-mcp-row-actions-p1')).toHaveFocus());
      expect(document.body.textContent).not.toContain('rotated-key');
    });

    it('empties the key field when its dialog closes without saving', async () => {
      listReturns([connection()]);
      renderSection();

      await pick('api-key');
      await fill(await screen.findByTestId('platform-mcp-api-key-input'), 'typed-key-0123456789');
      await userEvent.click(screen.getByTestId('platform-mcp-api-key-cancel-btn'));
      await waitFor(() => expect(screen.queryByTestId('platform-mcp-api-key-dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('platform-mcp-row-actions-p1')).toHaveFocus());

      await pick('api-key');
      expect(await screen.findByTestId('platform-mcp-api-key-input')).toHaveValue('');
      expect(api.post).not.toHaveBeenCalled();
    });

    it('shows a rate-limited key replacement as a plain message', async () => {
      listReturns([connection()]);
      vi.mocked(api.post).mockRejectedValueOnce(httpError(429, RATE_LIMITED));
      renderSection();

      await pick('api-key');
      await fill(await screen.findByTestId('platform-mcp-api-key-input'), 'rotated-key-0123456789');
      await userEvent.click(screen.getByTestId('platform-mcp-api-key-save-btn'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(RATE_LIMITED.error));
      expect(screen.getByTestId('platform-mcp-api-key-dialog')).toBeInTheDocument();
    });

    it('turns a connector off and another on for all users, in words', async () => {
      listReturns([connection(), connection({ id: 'p2', displayName: 'Open connector', enabled: false })]);
      vi.mocked(api.patch).mockImplementation((url: string, body: unknown) =>
        Promise.resolve({ data: connection({ id: url.split('/').pop(), ...(body as object) }) })
      );
      renderSection();

      await openMenu('p1');
      const off = screen.getByTestId('platform-mcp-toggle-p1');
      expect(off).toHaveTextContent('Turn off for all users');
      await userEvent.click(off);
      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p1`, { enabled: false });
      expect(await screen.findByTestId('platform-mcp-disabled-p1')).toHaveTextContent('Disabled');

      await openMenu('p2');
      expect(screen.getByTestId('platform-mcp-toggle-p2')).toHaveTextContent('Turn on for all users');
      await userEvent.click(screen.getByTestId('platform-mcp-toggle-p2'));
      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p2`, { enabled: true });
    });

    it('removes only after a dialog that says what users lose, then moves focus to Add connector', async () => {
      listReturns([connection(), connection({ id: 'p2', displayName: 'Open connector' })]);
      vi.mocked(api.delete).mockResolvedValueOnce({});
      renderSection();

      await pick('remove');
      const dialog = await screen.findByTestId('platform-mcp-remove-dialog');
      expect(dialog).toHaveTextContent('Users who turned it on lose its tools.');
      expect(dialog).toHaveTextContent('If you add it again later, it starts switched off for everyone.');
      expect(dialog).toHaveTextContent('Revoke the API key at the provider if you no longer need it.');
      const confirm = within(dialog).getByTestId('platform-mcp-remove-dialog-confirm-btn');
      expect(confirm).toBeDisabled();
      await userEvent.click(within(dialog).getByTestId('platform-mcp-remove-dialog-reason-input-preset-0'));
      await fill(within(dialog).getByTestId('platform-mcp-remove-dialog-typed-input'), 'Example connector');
      expect(api.delete).not.toHaveBeenCalled();
      await userEvent.click(confirm);

      await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${LIST_URL}/p1`));
      await waitFor(() => expect(screen.queryByTestId('platform-mcp-row-p1')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByTestId('platform-mcp-add-btn')).toHaveFocus());
    });
  });
});

describe('the connector hooks', () => {
  const hookWrapper = (queryClient: QueryClient) =>
    function Wrapper({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    };
  const seeded = () => {
    const queryClient = newClient();
    queryClient.setQueryData(mcpConnectionKeys.list(), []);
    queryClient.setQueryData(mcpConnectionKeys.platformList(), [connection()]);
    return queryClient;
  };
  const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
    queryClient.getQueryState(key)?.isInvalidated;

  it('re-reads the personal list after a platform write', async () => {
    const queryClient = seeded();
    vi.mocked(api.patch).mockResolvedValueOnce({ data: connection({ enabled: false }) });
    const { result } = renderHook(() => useUpdateMcpConnection('platform'), { wrapper: hookWrapper(queryClient) });

    await result.current.mutateAsync({ id: 'p1', enabled: false });

    expect(invalidated(queryClient, mcpConnectionKeys.list())).toBe(true);
    expect(queryClient.getQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.platformList())?.[0]?.enabled).toBe(
      false
    );
  });

  it('leaves the platform list alone after a personal write', async () => {
    const queryClient = seeded();
    vi.mocked(api.patch).mockResolvedValueOnce({ data: connection({ id: 'c1', ownerType: 'user' }) });
    const { result } = renderHook(() => useUpdateMcpConnection(), { wrapper: hookWrapper(queryClient) });

    await result.current.mutateAsync({ id: 'c1', enabled: false });

    expect(api.patch).toHaveBeenCalledWith(`${USER_URL}/c1`, { enabled: false });
    expect(invalidated(queryClient, mcpConnectionKeys.platformList())).toBe(false);
    expect(queryClient.getQueryData<IMcpConnectionPublic[]>(mcpConnectionKeys.platformList())).toHaveLength(1);
  });

  it('re-reads both lists after a failed platform refresh', async () => {
    const queryClient = seeded();
    vi.mocked(api.post).mockRejectedValueOnce(httpError(502, { error: 'The server did not answer.' }));
    const { result } = renderHook(() => useRefreshMcpConnectionTools('platform'), {
      wrapper: hookWrapper(queryClient),
    });

    await expect(result.current.mutateAsync('p1')).rejects.toThrow();

    expect(invalidated(queryClient, mcpConnectionKeys.platformList())).toBe(true);
    expect(invalidated(queryClient, mcpConnectionKeys.list())).toBe(true);
  });
});

describe('the connector components without a scope', () => {
  it('keep the user routes, the full address, the key ending and the personal removal copy', async () => {
    const own = connection({ ownerType: 'user', id: 'c1' });
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { ...own, enabled: false } });
    wrap(<McpConnectionItem connection={own} />);

    expect(screen.getByTestId('custom-mcp-connection-c1')).toHaveTextContent('https://mcp.example.com/mcp');
    expect(screen.getByTestId('custom-mcp-connection-c1-summary')).toHaveTextContent(/^1 of 2 tools on/);
    expect(screen.getByTestId('custom-mcp-connection-c1-enabled-switch')).toHaveAccessibleName('Use Example connector');
    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-btn'));
    expect(screen.getByTestId('custom-mcp-connection-c1-api-key-input')).toHaveAttribute(
      'placeholder',
      `Replaces the key ending ${KEY_LAST4}`
    );
    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-enabled-switch'));
    expect(api.patch).toHaveBeenCalledWith('/api/mcp-connections/c1', { enabled: false });

    h.confirm.mockImplementation(() => undefined);
    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-delete-btn'));
    expect(h.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        description:
          'This removes the connector and its tool settings. Revoke the API key at the provider if you no longer need it.',
      })
    );
  });

  it('empty the replace-key field when its panel closes without saving', async () => {
    wrap(<McpConnectionItem connection={connection({ ownerType: 'user', id: 'c1' })} />);

    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-btn'));
    await fill(screen.getByTestId('custom-mcp-connection-c1-api-key-input'), 'typed-key-0123456789');
    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-btn'));
    expect(screen.queryByTestId('custom-mcp-connection-c1-api-key-input')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-btn'));

    expect(screen.getByTestId('custom-mcp-connection-c1-api-key-input')).toHaveValue('');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('keep provider sign-in as the default and the personal warning on the add form', () => {
    wrap(<AddMcpConnectorForm onCreated={vi.fn()} />);

    expect(screen.getByTestId('custom-mcp-add-auth-oauth')).toBeChecked();
    expect(screen.getByTestId('custom-mcp-add-warning')).toHaveTextContent(
      'Its tools can read and change data in the account you connect'
    );
    expect(screen.getByTestId('custom-mcp-add-name-input')).not.toHaveFocus();
  });

  it('keep Ask for writes on a read-only tool and no platform note in a personal review', async () => {
    wrap(<McpConnectionItem connection={connection({ ownerType: 'user', id: 'c1' })} />);

    await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-review-btn'));
    expect(screen.queryByTestId('custom-mcp-review-c1-tool-create_page-approval-note')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('custom-mcp-review-c1-tool-search-approval'));
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual([
      'Ask for writes',
      'Always allow',
      'Always ask',
    ]);
  });
});
