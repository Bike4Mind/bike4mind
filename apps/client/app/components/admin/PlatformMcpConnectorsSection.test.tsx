import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';

const h = vi.hoisted(() => ({ confirm: vi.fn(), impersonating: false, featureOn: true }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => ({ currentUser: { isAdmin: true } }) }));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (s: { impersonating: boolean }) => unknown) =>
    selector({ impersonating: h.impersonating }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => h.confirm }));
vi.mock('@client/app/hooks/useAdminSettingsCache', () => ({
  useAdminSettingsCache: () => ({ isFeatureEnabled: () => h.featureOn }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import PlatformMcpConnectorsSection from './PlatformMcpConnectorsSection';
import McpConnectionItem from '@client/app/components/integrations/customMcp/McpConnectionItem';
import AddMcpConnectorForm from '@client/app/components/integrations/customMcp/AddMcpConnectorForm';

const appTheme = extendTheme({ ...getThemeConfig() });
const LIST_URL = '/api/admin/mcp-connections';
const KEY_LAST4 = 'wxyz';

const wrap = (node: React.ReactNode) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>{node}</CssVarsProvider>
    </QueryClientProvider>
  );
};
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

beforeEach(() => {
  vi.clearAllMocks();
  h.confirm.mockImplementation(({ onOk }: { onOk: () => void }) => onOk());
  h.impersonating = false;
  h.featureOn = true;
});

describe('PlatformMcpConnectorsSection', () => {
  describe('the list', () => {
    it('shows each connector with host, auth kind, status, approved tools and last use, and nothing of its key', async () => {
      listReturns([
        connection(),
        connection({
          id: 'p2',
          displayName: 'Open connector',
          urlHost: 'open.example.com',
          auth: { kind: 'none' },
          enabled: false,
        }),
        connection({ id: 'p3', displayName: 'Broken connector', status: 'needs_reconnect', lastUsedAt: undefined }),
      ]);
      renderSection();

      const first = await screen.findByTestId('custom-mcp-connection-p1');
      expect(screen.getByTestId('platform-mcp-section')).toHaveTextContent(
        "A platform connector appears in every user's Tools menu switched off, and nothing of it reaches a chat until that user turns it on."
      );
      expect(within(first).getByText('Example connector')).toBeInTheDocument();
      expect(within(first).getByTestId('custom-mcp-connection-p1-address')).toHaveTextContent(
        'mcp.example.com, API key'
      );
      expect(within(first).getByTestId('custom-mcp-connection-p1-status')).toHaveTextContent('Connected');
      expect(within(first).getByTestId('custom-mcp-connection-p1-summary')).toHaveTextContent(
        /^1 of 2 tools approved\. Last used /
      );
      expect(within(first).getByTestId('custom-mcp-connection-p1-enabled-switch')).toBeChecked();
      expect(within(first).queryByTestId('custom-mcp-connection-p1-disabled')).not.toBeInTheDocument();

      expect(screen.getByTestId('custom-mcp-connection-p2-address')).toHaveTextContent(
        'open.example.com, no authentication'
      );
      expect(screen.getByTestId('custom-mcp-connection-p2-disabled')).toHaveTextContent('Disabled');
      expect(screen.getByTestId('custom-mcp-connection-p2-enabled-switch')).not.toBeChecked();
      expect(screen.getByTestId('custom-mcp-connection-p3-status')).toHaveTextContent('Needs reconnect');
      expect(screen.getByTestId('custom-mcp-connection-p3-summary')).toHaveTextContent(/^1 of 2 tools approved$/);

      expect(document.body.textContent).not.toContain(KEY_LAST4);
      expect(document.body.textContent).not.toContain('/mcp');
    });

    it('shows a plain empty state with a way to add the first connector', async () => {
      listReturns([]);
      renderSection();

      const empty = await screen.findByTestId('admin-empty-state');
      expect(empty).toHaveTextContent('No platform connectors yet');
      await userEvent.click(within(empty).getByTestId('platform-mcp-add-btn'));
      expect(screen.getByTestId('custom-mcp-add-form')).toBeInTheDocument();
    });

    it('shows a loading state, then an error state that retries', async () => {
      let fail: (error: Error) => void = () => undefined;
      vi.mocked(api.get).mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)));
      renderSection();

      expect(screen.getByTestId('platform-mcp-loading')).toHaveTextContent('Loading connectors');
      fail(new Error('boom'));
      const error = await screen.findByTestId('admin-error-state');
      expect(error).toHaveTextContent('Could not load the platform connectors.');

      listReturns([connection()]);
      await userEvent.click(within(error).getByTestId('admin-error-retry-btn'));
      expect(await screen.findByTestId('custom-mcp-connection-p1')).toBeInTheDocument();
    });

    it('says so instead of loading forever while impersonating, and asks for nothing', () => {
      h.impersonating = true;
      renderSection();

      expect(screen.getByTestId('platform-mcp-impersonating')).toBeInTheDocument();
      expect(api.get).not.toHaveBeenCalled();
    });

    it('notes that users see nothing while the connector settings are off', async () => {
      h.featureOn = false;
      listReturns([connection()]);
      renderSection();

      expect(await screen.findByTestId('platform-mcp-feature-off')).toHaveTextContent('EnableCustomMcpConnectors');
    });
  });

  describe('adding a connector', () => {
    const fillForm = async () => {
      await userEvent.click(await screen.findByTestId('platform-mcp-add-btn'));
      await userEvent.type(screen.getByTestId('custom-mcp-add-name-input'), 'Example connector');
      await userEvent.type(screen.getByTestId('custom-mcp-add-url-input'), 'https://mcp.example.com/mcp');
      await userEvent.type(screen.getByTestId('custom-mcp-add-api-key-input'), 'example-key-0123456789');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));
    };

    it('offers an API key or no authentication, posts to the admin route and opens the tool review', async () => {
      listReturns([connection({ id: 'p0', displayName: 'Existing' })]);
      const created = connection({ tools: [tool('search'), tool('create_page')] });
      vi.mocked(api.post).mockResolvedValueOnce({ data: created });
      renderSection();

      await userEvent.click(await screen.findByTestId('platform-mcp-add-btn'));
      expect(screen.getByTestId('custom-mcp-add-auth-api_key')).toBeChecked();
      expect(screen.getByTestId('custom-mcp-add-auth-none')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-auth-oauth')).not.toBeInTheDocument();
      expect(screen.getByTestId('custom-mcp-add-warning')).toHaveTextContent('Every user can turn its tools on');
      await userEvent.click(screen.getByTestId('custom-mcp-add-cancel-btn'));
      await fillForm();

      expect(api.post).toHaveBeenCalledWith(LIST_URL, {
        url: 'https://mcp.example.com/mcp',
        displayName: 'Example connector',
        transport: 'auto',
        auth: { kind: 'api_key', value: 'example-key-0123456789', headerName: 'Authorization', scheme: 'Bearer' },
      });
      expect(await screen.findByTestId('custom-mcp-review-p1')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-form')).not.toBeInTheDocument();
    });

    it("shows the server's validation error inline and keeps the form", async () => {
      listReturns([]);
      vi.mocked(api.post).mockRejectedValueOnce(
        httpError(400, { error: 'Invalid request body', issues: [{ message: 'Use an https address.' }] })
      );
      renderSection();

      await fillForm();

      expect(await screen.findByTestId('custom-mcp-add-error')).toHaveTextContent('Use an https address.');
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
  });

  describe('managing a connector', () => {
    it('approves one tool and disables another through the admin route', async () => {
      const current = connection({ tools: [tool('search'), tool('create_page', { enabled: true, state: 'active' })] });
      listReturns([current]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: current });
      renderSection();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-p1-review-btn'));
      const review = screen.getByTestId('custom-mcp-review-p1');
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

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-p1-refresh-btn'));

      expect(api.post).toHaveBeenCalledWith(`${LIST_URL}/p1/refresh-tools`);
      expect(await screen.findByTestId('custom-mcp-review-p1-tool-added')).toBeInTheDocument();
    });

    it('replaces the API key through a write-only field that is cleared and never echoed', async () => {
      listReturns([connection({ status: 'needs_reconnect' })]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: connection() });
      renderSection();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-p1-api-key-btn'));
      const input = screen.getByTestId('custom-mcp-connection-p1-api-key-input');
      expect(input).toHaveAttribute('type', 'password');
      expect(input).toHaveAttribute('placeholder', 'API key');
      await userEvent.type(input, 'rotated-key-0123456789');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-p1-api-key-save-btn'));

      expect(api.post).toHaveBeenCalledWith(`${LIST_URL}/p1/api-key`, { value: 'rotated-key-0123456789' });
      await waitFor(() => expect(screen.getByTestId('custom-mcp-connection-p1-status')).toHaveTextContent('Connected'));
      expect(screen.queryByTestId('custom-mcp-connection-p1-api-key-input')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('custom-mcp-connection-p1-api-key-btn'));
      expect(screen.getByTestId('custom-mcp-connection-p1-api-key-input')).toHaveValue('');
      expect(document.body.textContent).not.toContain('rotated-key');
      expect(document.body.textContent).not.toContain(KEY_LAST4);
    });

    it('shows a rate-limited key replacement as a plain message', async () => {
      listReturns([connection()]);
      vi.mocked(api.post).mockRejectedValueOnce(httpError(429, RATE_LIMITED));
      renderSection();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-p1-api-key-btn'));
      await userEvent.type(screen.getByTestId('custom-mcp-connection-p1-api-key-input'), 'rotated-key-0123456789');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-p1-api-key-save-btn'));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(RATE_LIMITED.error));
      expect(screen.getByTestId('custom-mcp-connection-p1')).toBeInTheDocument();
    });

    it('disables an enabled connector and enables a disabled one', async () => {
      listReturns([connection(), connection({ id: 'p2', displayName: 'Open connector', enabled: false })]);
      vi.mocked(api.patch).mockImplementation((url: string, body: unknown) =>
        Promise.resolve({ data: connection({ id: url.split('/').pop(), ...(body as object) }) })
      );
      renderSection();

      const off = await screen.findByTestId('custom-mcp-connection-p1-enabled-switch');
      expect(off).toHaveAccessibleName('Offer Example connector to users');
      await userEvent.click(off);
      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p1`, { enabled: false });

      await userEvent.click(screen.getByTestId('custom-mcp-connection-p2-enabled-switch'));
      expect(api.patch).toHaveBeenCalledWith(`${LIST_URL}/p2`, { enabled: true });
    });

    it('deletes only after a confirmation that says what users lose', async () => {
      listReturns([connection()]);
      h.confirm.mockImplementation(() => undefined);
      vi.mocked(api.delete).mockResolvedValueOnce({});
      renderSection();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-p1-delete-btn'));

      expect(api.delete).not.toHaveBeenCalled();
      const [options] = h.confirm.mock.calls[0] as [{ type: string; description: string; onOk: () => void }];
      expect(options.type).toBe('danger');
      expect(options.description).toContain('Users who turned it on lose its tools.');
      expect(options.description).toContain('If you add it again later, it starts switched off for everyone.');

      options.onOk();
      await waitFor(() => expect(api.delete).toHaveBeenCalledWith(`${LIST_URL}/p1`));
      await waitFor(() => expect(screen.queryByTestId('custom-mcp-connection-p1')).not.toBeInTheDocument());
    });
  });
});

describe('the connector components without a scope', () => {
  it('keep the user routes, the full address, the key ending and the personal removal copy', async () => {
    const own = connection({ ownerType: 'user', id: 'c1' });
    vi.mocked(api.patch).mockResolvedValueOnce({ data: { ...own, enabled: false } });
    wrap(<McpConnectionItem connection={own} />);

    expect(screen.getByTestId('custom-mcp-connection-c1-address')).toHaveTextContent('https://mcp.example.com/mcp');
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

  it('keep provider sign-in as the default and the personal warning on the add form', () => {
    wrap(<AddMcpConnectorForm onCreated={vi.fn()} />);

    expect(screen.getByTestId('custom-mcp-add-auth-oauth')).toBeChecked();
    expect(screen.getByTestId('custom-mcp-add-warning')).toHaveTextContent(
      'Its tools can read and change data in the account you connect'
    );
  });
});
