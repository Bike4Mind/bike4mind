import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { IMcpConnectionPublic } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import { api } from '@client/app/contexts/ApiContext';

const h = vi.hoisted(() => ({ confirm: vi.fn(), impersonating: false }));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock('@client/app/hooks/useAccessToken', () => ({
  useAccessToken: (selector: (s: { impersonating: boolean }) => unknown) =>
    selector({ impersonating: h.impersonating }),
}));
vi.mock('@client/app/hooks/useConfirmation', () => ({ useConfirmation: () => h.confirm }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import CustomMcpConnectorPanel from './CustomMcpConnectorPanel';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderPanel = (props: React.ComponentProps<typeof CustomMcpConnectorPanel> = {}) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <CustomMcpConnectorPanel {...props} />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

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
    id: 'c1',
    ownerType: 'user',
    userId: 'u1',
    slug: 'docs',
    displayName: 'Docs server',
    displayUrl: 'https://mcp.example.test/mcp',
    urlHost: 'mcp.example.test',
    transport: 'auto',
    auth: { kind: 'none' },
    status: 'connected',
    tools: [],
    enabled: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  }) as unknown as IMcpConnectionPublic;

const listReturns = (connections: IMcpConnectionPublic[]) =>
  vi.mocked(api.get).mockResolvedValue({ data: connections });

beforeEach(() => {
  vi.clearAllMocks();
  h.confirm.mockImplementation(({ onOk }: { onOk: () => void }) => onOk());
  h.impersonating = false;
});

describe('CustomMcpConnectorPanel', () => {
  it('shows a note instead of a loading state while impersonating, and asks for nothing', () => {
    h.impersonating = true;
    renderPanel();

    expect(screen.getByTestId('custom-mcp-panel-impersonating')).toBeInTheDocument();
    expect(screen.queryByTestId('custom-mcp-panel-loading')).not.toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  describe('adding a connector', () => {
    it('shows the add form with the unreviewed-server warning when there is no connection yet', async () => {
      listReturns([]);
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-add-form')).toBeInTheDocument();
      expect(screen.getByTestId('custom-mcp-add-warning')).toHaveTextContent(/has not reviewed this server/);
      expect(screen.getByTestId('custom-mcp-add-submit-btn')).toBeDisabled();
    });

    it('creates an API-key connection and opens the review of its tools', async () => {
      listReturns([]);
      const created = connection({
        auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: 'cdef' } },
        tools: [tool('search', { annotations: { readOnlyHint: true } }), tool('create_page')],
      });
      vi.mocked(api.post).mockResolvedValueOnce({ data: created });
      renderPanel();

      await userEvent.type(await screen.findByTestId('custom-mcp-add-name-input'), 'Docs server');
      await userEvent.type(screen.getByTestId('custom-mcp-add-url-input'), 'https://mcp.example.test/mcp');
      await userEvent.click(screen.getByTestId('custom-mcp-add-auth-api_key'));
      await userEvent.type(screen.getByTestId('custom-mcp-add-api-key-input'), 'secret-key-abcdef');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));

      expect(api.post).toHaveBeenCalledWith('/api/mcp-connections', {
        url: 'https://mcp.example.test/mcp',
        displayName: 'Docs server',
        transport: 'auto',
        auth: { kind: 'api_key', value: 'secret-key-abcdef', headerName: 'Authorization', scheme: 'Bearer' },
      });
      const review = await screen.findByTestId('custom-mcp-review-c1');
      expect(within(review).getByTestId('custom-mcp-review-c1-tool-search-kind')).toHaveTextContent('Read');
      expect(within(review).getByTestId('custom-mcp-review-c1-tool-create_page-kind')).toHaveTextContent('Write');
      expect(screen.queryByTestId('custom-mcp-add-form')).not.toBeInTheDocument();
    });

    it('shows the server error and keeps the form when the create is refused', async () => {
      listReturns([]);
      vi.mocked(api.post).mockRejectedValueOnce(
        Object.assign(new Error('400'), {
          isAxiosError: true,
          response: { status: 400, data: { error: 'Invalid request body', issues: [{ message: 'Bad URL' }] } },
        })
      );
      renderPanel();

      await userEvent.type(await screen.findByTestId('custom-mcp-add-name-input'), 'X');
      await userEvent.type(screen.getByTestId('custom-mcp-add-url-input'), 'nope');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));

      expect(await screen.findByTestId('custom-mcp-add-error')).toHaveTextContent('Bad URL');
      expect(screen.getByTestId('custom-mcp-add-form')).toBeInTheDocument();
    });

    it('sends the advanced settings and refuses a reserved tool prefix before submitting', async () => {
      listReturns([]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: connection() });
      renderPanel();

      await userEvent.type(await screen.findByTestId('custom-mcp-add-name-input'), 'Docs server');
      await userEvent.type(screen.getByTestId('custom-mcp-add-url-input'), 'https://mcp.example.test/mcp');
      await userEvent.click(screen.getByTestId('custom-mcp-add-auth-api_key'));
      await userEvent.type(screen.getByTestId('custom-mcp-add-api-key-input'), 'secret-key-abcdef');
      await userEvent.click(screen.getByTestId('custom-mcp-add-advanced-btn'));

      await userEvent.type(screen.getByTestId('custom-mcp-add-slug-input'), 'github');
      expect(screen.getByTestId('custom-mcp-add-submit-btn')).toBeDisabled();

      await userEvent.clear(screen.getByTestId('custom-mcp-add-slug-input'));
      await userEvent.type(screen.getByTestId('custom-mcp-add-slug-input'), 'docs');
      await userEvent.clear(screen.getByTestId('custom-mcp-add-header-input'));
      await userEvent.type(screen.getByTestId('custom-mcp-add-header-input'), 'X-Api-Key');
      await userEvent.click(screen.getByTestId('custom-mcp-add-scheme'));
      await userEvent.click(await screen.findByRole('option', { name: 'Key only' }));
      await userEvent.click(screen.getByTestId('custom-mcp-add-transport'));
      await userEvent.click(await screen.findByRole('option', { name: 'Streamable HTTP' }));
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));

      expect(api.post).toHaveBeenCalledWith('/api/mcp-connections', {
        url: 'https://mcp.example.test/mcp',
        displayName: 'Docs server',
        slug: 'docs',
        transport: 'streamable-http',
        auth: { kind: 'api_key', value: 'secret-key-abcdef', headerName: 'X-Api-Key', scheme: 'raw' },
      });
    });

    it('fixes the server URL and API-key sign-in for a preset and names the preset on create', async () => {
      listReturns([]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: connection({ presetId: 'linear' }) });
      renderPanel({ presetId: 'linear', presetName: 'Linear' });

      const url = await screen.findByTestId('custom-mcp-add-url-input');
      expect(url).toHaveValue('https://mcp.linear.app/mcp');
      expect(url).toHaveAttribute('readonly');
      expect(screen.queryByTestId('custom-mcp-add-auth')).not.toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-warning')).not.toBeInTheDocument();

      await userEvent.type(screen.getByTestId('custom-mcp-add-api-key-input'), 'lin_api_1234567890');
      await userEvent.click(screen.getByTestId('custom-mcp-add-submit-btn'));

      expect(api.post).toHaveBeenCalledWith(
        '/api/mcp-connections',
        expect.objectContaining({
          presetId: 'linear',
          url: 'https://mcp.linear.app/mcp',
          displayName: 'Linear',
          auth: expect.objectContaining({ kind: 'api_key', value: 'lin_api_1234567890' }),
        })
      );
    });

    it('lists only the preset connection in a preset drawer and offers no second one', async () => {
      listReturns([connection({ id: 'p1', presetId: 'linear' }), connection({ id: 'c2' })]);
      renderPanel({ presetId: 'linear', presetName: 'Linear' });

      expect(await screen.findByTestId('custom-mcp-connection-p1')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-connection-c2')).not.toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-add-btn')).not.toBeInTheDocument();
    });
  });

  describe('reviewing tools', () => {
    it('keeps new tools off until reviewed and saves every tool as reviewed with the version shown', async () => {
      const current = connection({
        tools: [tool('search', { annotations: { readOnlyHint: true } }), tool('delete_page')],
      });
      listReturns([current]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: current });
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-connection-c1-status')).toHaveTextContent('Pending review');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-review-btn'));

      expect(screen.getByTestId('custom-mcp-review-c1-tool-search-switch')).not.toBeChecked();
      expect(screen.getByTestId('custom-mcp-review-c1-tool-delete_page-switch')).not.toBeChecked();
      expect(screen.getByTestId('custom-mcp-review-c1-tool-search-pending')).toBeInTheDocument();

      await userEvent.click(screen.getByTestId('custom-mcp-review-c1-tool-search-switch'));
      await userEvent.click(screen.getByTestId('custom-mcp-review-c1-save-btn'));

      expect(api.patch).toHaveBeenCalledWith('/api/mcp-connections/c1', {
        tools: [
          { name: 'search', versionHash: 'v-search', enabled: true, approval: 'default', state: 'active' },
          { name: 'delete_page', versionHash: 'v-delete_page', enabled: false, approval: 'default', state: 'active' },
        ],
      });
      await waitFor(() => expect(screen.queryByTestId('custom-mcp-review-c1')).not.toBeInTheDocument());
    });

    it('keeps reviewing the versions it opened with when a refresh brings new or changed tools', async () => {
      const opened = connection({ tools: [tool('search')] });
      listReturns([opened]);
      vi.mocked(api.post).mockResolvedValueOnce({
        data: {
          connection: { ...opened, tools: [tool('search', { versionHash: 'v-search-2' }), tool('added')] },
          discovery: { added: ['added'], changed: ['search'], removed: [], dropped: 0 },
        },
      });
      vi.mocked(api.patch).mockResolvedValueOnce({ data: opened });
      renderPanel();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-c1-review-btn'));
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-refresh-btn'));

      expect(api.post).toHaveBeenCalledWith('/api/mcp-connections/c1/refresh-tools');
      await waitFor(() =>
        expect(screen.getByTestId('custom-mcp-connection-c1-summary')).toHaveTextContent('of 2 tools')
      );
      expect(screen.getByTestId('custom-mcp-review-c1')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-review-c1-tool-added')).not.toBeInTheDocument();

      await userEvent.click(screen.getByTestId('custom-mcp-review-c1-save-btn'));
      expect(api.patch).toHaveBeenCalledWith('/api/mcp-connections/c1', {
        tools: [{ name: 'search', versionHash: 'v-search', enabled: false, approval: 'default', state: 'active' }],
      });
    });

    it('closes the review and re-reads the connection when a tool changed meanwhile', async () => {
      listReturns([connection({ tools: [tool('search')] })]);
      vi.mocked(api.patch).mockRejectedValueOnce(
        Object.assign(new Error('409'), {
          isAxiosError: true,
          response: { status: 409, data: { error: 'changed', code: 'tool_version_conflict' } },
        })
      );
      renderPanel();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-c1-review-btn'));
      await userEvent.click(screen.getByTestId('custom-mcp-review-c1-save-btn'));

      await waitFor(() => expect(screen.queryByTestId('custom-mcp-review-c1')).not.toBeInTheDocument());
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('managing a connection', () => {
    it('disables a connector with its switch', async () => {
      const current = connection({ tools: [tool('search', { state: 'active', enabled: true })] });
      listReturns([current]);
      vi.mocked(api.patch).mockResolvedValueOnce({ data: { ...current, enabled: false } });
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-connection-c1-summary')).toHaveTextContent('1 of 1 tool on');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-enabled-switch'));

      expect(api.patch).toHaveBeenCalledWith('/api/mcp-connections/c1', { enabled: false });
      await waitFor(() => expect(screen.getByTestId('custom-mcp-connection-c1-enabled-switch')).not.toBeChecked());
    });

    it('removes a connector after confirmation', async () => {
      listReturns([connection()]);
      vi.mocked(api.delete).mockResolvedValueOnce({});
      renderPanel();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-c1-delete-btn'));

      expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ type: 'danger', okLabel: 'Remove' }));
      expect(api.delete).toHaveBeenCalledWith('/api/mcp-connections/c1');
      await waitFor(() => expect(screen.queryByTestId('custom-mcp-connection-c1')).not.toBeInTheDocument());
    });

    it('keeps the connector when the removal is cancelled', async () => {
      listReturns([connection()]);
      h.confirm.mockImplementation(() => undefined);
      renderPanel();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-c1-delete-btn'));

      expect(h.confirm).toHaveBeenCalledTimes(1);
      expect(api.delete).not.toHaveBeenCalled();
      expect(screen.getByTestId('custom-mcp-connection-c1')).toBeInTheDocument();
    });

    it('replaces the API key and shows the new status', async () => {
      const keyed = connection({
        status: 'needs_reconnect',
        auth: { kind: 'api_key', apiKey: { headerName: 'Authorization', scheme: 'Bearer', last4: 'abcd' } },
      });
      listReturns([keyed]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: { ...keyed, status: 'connected' } });
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-connection-c1-status')).toHaveTextContent('Needs reconnect');
      expect(screen.queryByTestId('custom-mcp-connection-c1-sign-in-btn')).not.toBeInTheDocument();
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-btn'));
      await userEvent.type(screen.getByTestId('custom-mcp-connection-c1-api-key-input'), 'new-secret-key-1234');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-api-key-save-btn'));

      expect(api.post).toHaveBeenCalledWith('/api/mcp-connections/c1/api-key', { value: 'new-secret-key-1234' });
      await waitFor(() => expect(screen.getByTestId('custom-mcp-connection-c1-status')).toHaveTextContent('Connected'));
      expect(screen.queryByTestId('custom-mcp-connection-c1-api-key-input')).not.toBeInTheDocument();
    });

    it('starts sign-in for a server waiting for it and leaves for the provider', async () => {
      listReturns([connection({ status: 'pending_auth', auth: { kind: 'oauth' } })]);
      vi.mocked(api.post).mockResolvedValueOnce({ data: { authorizationUrl: 'https://auth.example.test/authorize' } });
      const location = { href: '' };
      vi.spyOn(window, 'location', 'get').mockReturnValue(location as unknown as Location);
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-connection-c1-status')).toHaveTextContent('Needs sign-in');
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-sign-in-btn'));

      expect(api.post).toHaveBeenCalledWith('/api/mcp-connections/c1/oauth/start', {});
      await waitFor(() => expect(location.href).toBe('https://auth.example.test/authorize'));
      vi.restoreAllMocks();
    });

    it('asks for a client id when the server offers no client registration', async () => {
      listReturns([connection({ status: 'pending_auth', auth: { kind: 'oauth' } })]);
      vi.mocked(api.post).mockRejectedValueOnce(
        Object.assign(new Error('400'), {
          isAxiosError: true,
          response: { status: 400, data: { error: 'needs client', code: 'client_required' } },
        })
      );
      renderPanel();

      await userEvent.click(await screen.findByTestId('custom-mcp-connection-c1-sign-in-btn'));
      await userEvent.type(await screen.findByTestId('custom-mcp-connection-c1-client-id-input'), 'my-client');
      vi.mocked(api.post).mockResolvedValueOnce({ data: { authorizationUrl: 'https://auth.example.test/a' } });
      await userEvent.click(screen.getByTestId('custom-mcp-connection-c1-client-sign-in-btn'));

      expect(api.post).toHaveBeenLastCalledWith('/api/mcp-connections/c1/oauth/start', { clientId: 'my-client' });
    });

    it('offers only removal for a connection the org policy blocks', async () => {
      listReturns([connection({ status: 'blocked_by_policy', tools: [tool('search', { state: 'active' })] })]);
      renderPanel();

      expect(await screen.findByTestId('custom-mcp-connection-c1-status')).toHaveTextContent('Blocked by admin');
      expect(screen.getByTestId('custom-mcp-connection-c1-delete-btn')).toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-connection-c1-review-btn')).not.toBeInTheDocument();
      expect(screen.queryByTestId('custom-mcp-connection-c1-refresh-btn')).not.toBeInTheDocument();
      expect(screen.getByTestId('custom-mcp-connection-c1-enabled-switch')).toBeDisabled();
    });
  });
});
