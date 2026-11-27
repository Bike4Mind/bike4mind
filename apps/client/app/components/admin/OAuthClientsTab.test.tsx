import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { AdminTab } from './adminSidebarConfig';
import { useCreditAnalysisStore } from './CreditAnalysis/store';
import { useAdminModal } from './useAdminModal';

const { api, copy, adminSettings, navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
  adminSettings: {
    loaded: true,
    values: {
      apiKeyUntrustedRateLimitPerMin: 20,
      apiKeyUntrustedRequestsPerDay: 0,
      apiKeyUntrustedTokensPerMin: 0,
      apiKeyUntrustedMaxConcurrent: 0,
    } as Record<string, number>,
    trustGate: true,
  },
  api: {
    fetchOAuthClients: vi.fn(),
    fetchOAuthClientStats: vi.fn(),
    OAUTH_CLIENTS_QUERY_KEY: 'admin-oauth-clients',
    createOAuthClient: vi.fn(),
    updateOAuthClient: vi.fn(),
    rotateOAuthClientSecret: vi.fn(),
  },
  copy: vi.fn(),
}));

vi.mock('@client/app/utils/oauthClientAPICalls', () => api);
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: copy }),
}));
vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    authedSettingsLoaded: adminSettings.loaded,
    getSettingNumber: (key: string, fallback = 0) => adminSettings.values[key] ?? fallback,
    getSettingBoolean: (_key: string, fallback = false) => (adminSettings.loaded ? adminSettings.trustGate : fallback),
  }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import OAuthClientsTab, {
  buildCreatePayload,
  buildEditPayload,
  editFormFromClient,
  federatedFormFromClient,
} from './OAuthClientsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderTab = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider theme={appTheme}>
        <OAuthClientsTab />
      </CssVarsProvider>
    </QueryClientProvider>
  );
};

const client = {
  id: 'c1',
  clientId: 'b4m_my_app_0011aabb',
  name: 'My App',
  clientType: 'relying-party',
  tokenEndpointAuthMethod: 'client_secret_post',
  redirectUris: ['https://app.example.test/cb'],
  allowedScopes: ['openid', 'email', 'profile'],
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const SECRET = 'shown-once-secret';

// Edit and rotate live in each row's "..." menu, which renders its items only while open.
const openRowAction = async (action: 'edit' | 'rotate' | 'usage', clientId = client.clientId) => {
  fireEvent.click(await screen.findByTestId(`oauth-client-actions-${clientId}`));
  fireEvent.click(await screen.findByTestId(`oauth-client-${action}-${clientId}`));
};

// Rotate and deactivate confirm in an ActionDialog, whose commit unlocks once a reason is picked.
const pickReason = (dialog: 'rotate' | 'deactivate') =>
  fireEvent.click(screen.getByTestId(`oauth-client-${dialog}-modal-reason-input-preset-0`));

beforeEach(() => {
  // Not resetAllMocks: that also wipes global setup mocks (matchMedia) the theme provider needs.
  for (const fn of [...Object.values(api).filter(v => typeof v === 'function'), copy, navigate, toast.success, toast.error]) vi.mocked(fn).mockReset();
  api.fetchOAuthClients.mockResolvedValue([client]);
  api.fetchOAuthClientStats.mockResolvedValue({
    [client.clientId]: { signups7d: 2, signups30d: 5, activeUsers7d: 3, activeUsers30d: 9 },
  });
  adminSettings.loaded = true;
  adminSettings.trustGate = true;
});

describe('OAuthClientsTab', () => {
  it('lists clients with their id, type, redirect URIs and scopes', async () => {
    renderTab();
    const row = await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb');
    expect(row).toHaveTextContent('My App');
    expect(row).toHaveTextContent('relying-party');
    expect(row).toHaveTextContent('https://app.example.test/cb');
    expect(row).toHaveTextContent('profile');
  });

  it('registers a client and shows the secret once with copy buttons and a notice', async () => {
    api.createOAuthClient.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb\nhttp://localhost:9999/callback' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));

    await screen.findByTestId('oauth-client-secret-modal');
    expect(api.createOAuthClient).toHaveBeenCalledWith({
      name: 'My App',
      redirectUris: ['https://app.example.test/cb', 'http://localhost:9999/callback'],
      clientType: 'relying-party',
    });
    expect(screen.getByTestId('oauth-client-secret-notice')).toHaveTextContent(/will not be shown again/i);
    expect(screen.getByTestId('oauth-client-secret-modal-secret-value')).toHaveValue(SECRET);

    fireEvent.click(screen.getByTestId('oauth-client-secret-modal-secret-copy-btn'));
    expect(copy).toHaveBeenCalledWith(SECRET);
    fireEvent.click(screen.getByTestId('oauth-client-secret-modal-client-id-copy-btn'));
    expect(copy).toHaveBeenCalledWith(client.clientId);

    fireEvent.click(screen.getByTestId('oauth-client-secret-done-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-secret-modal')).not.toBeInTheDocument());
    const values = Array.from(document.querySelectorAll('input, textarea')).map(el => (el as HTMLInputElement).value);
    expect(values).not.toContain(SECRET);
  });

  it('closes the secret modal from its close button', async () => {
    api.createOAuthClient.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));
    await screen.findByTestId('oauth-client-secret-modal');

    fireEvent.click(screen.getByTestId('oauth-client-secret-modal-close-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-secret-modal')).not.toBeInTheDocument());
  });

  it('keeps the secret modal open on Escape and backdrop click; only Done closes it', async () => {
    api.createOAuthClient.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));
    const modal = await screen.findByTestId('oauth-client-secret-modal');

    fireEvent.keyDown(modal, { key: 'Escape' });
    fireEvent.click(modal.parentElement as HTMLElement);
    expect(screen.getByTestId('oauth-client-secret-modal')).toBeInTheDocument();
    expect(screen.getByTestId('oauth-client-secret-modal-secret-value')).toHaveValue(SECRET);

    fireEvent.click(screen.getByTestId('oauth-client-secret-done-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-secret-modal')).not.toBeInTheDocument());
  });

  it('closes the register dialog on Escape when idle, but not while the registration is in flight', async () => {
    let resolveCreate: (v: { client: typeof client; clientSecret: string }) => void = () => {};
    api.createOAuthClient.mockReturnValue(new Promise(r => (resolveCreate = r)));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.keyDown(screen.getByTestId('oauth-client-create-modal'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('oauth-client-create-modal')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));
    await waitFor(() => expect(api.createOAuthClient).toHaveBeenCalled());
    const closeBtn = await screen.findByTestId('oauth-client-create-modal-close-btn');
    await waitFor(() => expect(closeBtn).toBeDisabled());
    expect(
      within(screen.getByTestId('oauth-client-create-modal')).getByRole('button', { name: 'Cancel' })
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('oauth-client-create-modal'), { key: 'Escape' });
    expect(screen.getByTestId('oauth-client-create-modal')).toBeInTheDocument();

    resolveCreate({ client, clientSecret: SECRET });
    await screen.findByTestId('oauth-client-secret-modal');
  });

  it('keeps the edit dialog open on Escape while the save is in flight', async () => {
    let resolveUpdate: (v: typeof client) => void = () => {};
    api.updateOAuthClient.mockReturnValue(new Promise(r => (resolveUpdate = r)));
    renderTab();
    await openRowAction('edit');
    fireEvent.change(screen.getByTestId('oauth-client-edit-uris-input'), {
      target: { value: 'https://app.example.test/new' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() => expect(screen.getByTestId('oauth-client-edit-modal-close-btn')).toBeDisabled());
    expect(
      within(screen.getByTestId('oauth-client-edit-modal')).getByRole('button', { name: 'Cancel' })
    ).toBeDisabled();
    fireEvent.keyDown(screen.getByTestId('oauth-client-edit-modal'), { key: 'Escape' });
    expect(screen.getByTestId('oauth-client-edit-modal')).toBeInTheDocument();
    resolveUpdate(client);
  });

  it('submits a federated identities payload from the form', async () => {
    api.createOAuthClient.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-federated-switch'));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('option', { name: /^identities/ }));
    fireEvent.change(screen.getByTestId('oauth-client-federated-issuer-input'), {
      target: { value: 'https://idp.example.test/pool' },
    });
    fireEvent.change(screen.getByTestId('oauth-client-federated-audience-input'), { target: { value: 'app-client' } });
    fireEvent.change(screen.getByTestId('oauth-client-federated-provider-input'), { target: { value: 'B4M' } });
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));

    await waitFor(() =>
      expect(api.createOAuthClient).toHaveBeenCalledWith({
        name: 'My App',
        redirectUris: ['https://app.example.test/cb'],
        clientType: 'relying-party',
        federatedIdp: {
          subjectSource: 'identities',
          issuer: 'https://idp.example.test/pool',
          audience: 'app-client',
          providerName: 'B4M',
          jwksUri: undefined,
        },
      })
    );
  });

  it('sends the federated object with blank fields and shows the server rejection', async () => {
    api.createOAuthClient.mockRejectedValue(new Error("Federated subject source 'sub' requires an issuer"));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-federated-switch'));
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));

    expect(await screen.findByTestId('oauth-client-form-error')).toHaveTextContent(/requires an issuer/);
    expect(api.createOAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({ federatedIdp: expect.objectContaining({ subjectSource: 'sub' }) })
    );
  });

  it('words the deactivate confirmation per client type', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, clientType: 'first-party' }]);
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
    expect(screen.getByTestId('oauth-client-deactivate-modal')).toHaveTextContent(/sessions it already created/i);
  });

  it('renders a client without timestamps', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, createdAt: null, updatedAt: null }]);
    renderTab();
    expect(await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb')).toBeInTheDocument();
  });

  it('shows the server error when registration is rejected', async () => {
    api.createOAuthClient.mockRejectedValue(new Error('An OAuth client named "My App" already exists'));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));
    expect(await screen.findByTestId('oauth-client-form-error')).toHaveTextContent(/already exists/);
  });

  it('rotates only after confirmation and shows the new secret', async () => {
    api.rotateOAuthClientSecret.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    await openRowAction('rotate');
    expect(api.rotateOAuthClientSecret).not.toHaveBeenCalled();
    pickReason('rotate');
    fireEvent.click(screen.getByTestId('oauth-client-rotate-confirm-btn'));

    await screen.findByTestId('oauth-client-secret-modal');
    expect(api.rotateOAuthClientSecret).toHaveBeenCalledWith('c1');
    expect(screen.getByTestId('oauth-client-secret-notice')).toHaveTextContent(/previous secret has stopped working/i);
  });

  it('deactivates only after confirmation', async () => {
    api.updateOAuthClient.mockResolvedValue({ ...client, isActive: false });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
    expect(api.updateOAuthClient).not.toHaveBeenCalled();
    pickReason('deactivate');
    fireEvent.click(screen.getByTestId('oauth-client-deactivate-confirm-btn'));
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', { isActive: false }));
  });

  it('opens the side apps view for the client from the row menu', async () => {
    api.fetchOAuthClients.mockResolvedValue([client]);
    renderTab();
    await openRowAction('usage');
    expect(useCreditAnalysisStore.getState()).toMatchObject({
      activeTab: 'side-apps',
      sideAppClientId: client.clientId,
    });
    expect(useAdminModal.getState().activeTab).toBe(AdminTab.CreditAnalytics);
  });

  it('edits redirect URIs', async () => {
    api.updateOAuthClient.mockResolvedValue(client);
    renderTab();
    await openRowAction('edit');
    fireEvent.change(screen.getByTestId('oauth-client-edit-uris-input'), {
      target: { value: 'https://app.example.test/new\n' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        redirectUris: ['https://app.example.test/new'],
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('registers post-logout redirect URIs from the form', async () => {
    api.createOAuthClient.mockResolvedValue({ client, clientSecret: SECRET });
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    fireEvent.change(screen.getByTestId('oauth-client-name-input'), { target: { value: 'My App' } });
    fireEvent.change(screen.getByTestId('oauth-client-redirect-uris-input'), {
      target: { value: 'https://app.example.test/cb' },
    });
    fireEvent.change(screen.getByTestId('oauth-client-post-logout-uris-input'), {
      target: { value: 'https://app.example.test/signed-out\n' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-create-submit-btn'));
    await waitFor(() =>
      expect(api.createOAuthClient).toHaveBeenCalledWith({
        name: 'My App',
        redirectUris: ['https://app.example.test/cb'],
        postLogoutRedirectUris: ['https://app.example.test/signed-out'],
        clientType: 'relying-party',
      })
    );
  });

  it('edits post-logout redirect URIs', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, postLogoutRedirectUris: ['https://app.example.test/out'] }]);
    api.updateOAuthClient.mockResolvedValue(client);
    renderTab();
    await openRowAction('edit');
    const input = screen.getByTestId('oauth-client-edit-post-logout-uris-input');
    expect(input).toHaveValue('https://app.example.test/out');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        postLogoutRedirectUris: [],
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('re-activates an inactive client directly, without the deactivate confirmation', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, isActive: false }]);
    api.updateOAuthClient.mockResolvedValue(client);
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', { isActive: true }));
    expect(screen.queryByTestId('oauth-client-deactivate-modal')).not.toBeInTheDocument();
  });

  it('keeps the edit modal open and shows the error when saving redirect URIs fails', async () => {
    api.updateOAuthClient.mockRejectedValue(new Error('Redirect URI must not contain whitespace'));
    renderTab();
    await openRowAction('edit');
    fireEvent.change(screen.getByTestId('oauth-client-edit-uris-input'), {
      target: { value: 'https://x.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    expect(await screen.findByTestId('oauth-client-edit-error')).toHaveTextContent(/must not contain whitespace/);
    expect(screen.getByTestId('oauth-client-edit-modal')).toBeInTheDocument();
    await waitFor(() => expect(api.fetchOAuthClients).toHaveBeenCalledTimes(2));
  });

  it('hints to reopen the client when the save conflicts (409), and not for other errors', async () => {
    const conflict = Object.assign(new Error('conflict'), {
      isAxiosError: true,
      response: { status: 409, data: { message: 'Client was changed by someone else' } },
    });
    api.updateOAuthClient.mockRejectedValueOnce(conflict);
    renderTab();
    await openRowAction('edit');
    fireEvent.change(screen.getByTestId('oauth-client-edit-uris-input'), {
      target: { value: 'https://x.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    expect(await screen.findByTestId('oauth-client-edit-error')).toHaveTextContent(
      /Client was changed by someone else Close and reopen this client/
    );

    api.updateOAuthClient.mockRejectedValueOnce(new Error('Redirect URI must not contain whitespace'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() =>
      expect(screen.getByTestId('oauth-client-edit-error')).toHaveTextContent(/must not contain whitespace/)
    );
    expect(screen.getByTestId('oauth-client-edit-error')).not.toHaveTextContent(/Close and reopen/);
  });

  it('toasts the error and shows no secret modal when rotation fails', async () => {
    api.rotateOAuthClientSecret.mockRejectedValue(new Error('rotate failed'));
    renderTab();
    await openRowAction('rotate');
    pickReason('rotate');
    fireEvent.click(screen.getByTestId('oauth-client-rotate-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rotate failed'));
    expect(screen.queryByTestId('oauth-client-secret-modal')).not.toBeInTheDocument();
    expect(screen.getByTestId('oauth-client-rotate-modal')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('oauth-client-rotate-confirm-btn')).toBeEnabled());
  });

  it('toasts the error when deactivation fails', async () => {
    api.updateOAuthClient.mockRejectedValue(new Error('deactivate failed'));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
    pickReason('deactivate');
    fireEvent.click(screen.getByTestId('oauth-client-deactivate-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('deactivate failed'));
    expect(screen.getByTestId('oauth-client-deactivate-modal')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a load error instead of the empty state when the list fetch fails', async () => {
    api.fetchOAuthClients.mockRejectedValue(new Error('Forbidden'));
    renderTab();
    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent(/Forbidden/);
    expect(screen.queryByTestId('oauth-clients-empty')).not.toBeInTheDocument();
  });

  it('keeps the table and shows a non-blocking warning when a background refetch fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <CssVarsProvider theme={appTheme}>
          <OAuthClientsTab />
        </CssVarsProvider>
      </QueryClientProvider>
    );
    await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb');

    api.fetchOAuthClients.mockRejectedValue(new Error('Gateway timeout'));
    await queryClient.refetchQueries({ queryKey: ['admin-oauth-clients'] });

    expect(await screen.findByTestId('oauth-clients-refresh-error')).toHaveTextContent(/Gateway timeout/);
    expect(screen.getByTestId('oauth-client-row-b4m_my_app_0011aabb')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).not.toBeInTheDocument();
  });

  it('hides rotate for a public (PKCE) client', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, tokenEndpointAuthMethod: 'none' }]);
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-actions-b4m_my_app_0011aabb'));
    expect(await screen.findByTestId('oauth-client-edit-b4m_my_app_0011aabb')).toBeInTheDocument();
    expect(screen.queryByTestId('oauth-client-rotate-b4m_my_app_0011aabb')).not.toBeInTheDocument();
  });

  it('copies the client ID from a button in its cell that shows on row hover', async () => {
    renderTab();
    const button = await screen.findByTestId('oauth-client-copy-id-b4m_my_app_0011aabb');
    const reveal = button.closest('[data-row-actions]') as HTMLElement;

    expect(button).toHaveAccessibleName('Copy client ID');
    expect(reveal).not.toBeNull();
    expect(getComputedStyle(reveal).opacity).toBe('0');
    expect(screen.getByTestId('oauth-client-row-b4m_my_app_0011aabb')).toContainElement(button);
    fireEvent.click(button);
    expect(copy).toHaveBeenCalledWith('b4m_my_app_0011aabb');
  });
});

describe('OAuthClientsTab usage columns', () => {
  it('shows sign-ups and active users per client', async () => {
    renderTab();
    expect(await screen.findByTestId(`oauth-client-signups-link-${client.clientId}`)).toHaveTextContent('2 / 5');
    expect(screen.getByTestId(`oauth-client-active-users-${client.clientId}`)).toHaveTextContent('3 / 9');
  });

  it('shows dashes while the stats load', async () => {
    api.fetchOAuthClientStats.mockReturnValue(new Promise(() => undefined));
    renderTab();
    const row = await screen.findByTestId(`oauth-client-row-${client.clientId}`);
    expect(row).toHaveTextContent('\u2014');
    expect(screen.queryByTestId(`oauth-client-signups-link-${client.clientId}`)).not.toBeInTheDocument();
  });

  it('keeps the list and shows dashes when the stats request fails', async () => {
    api.fetchOAuthClientStats.mockRejectedValue(new Error('boom'));
    renderTab();
    const row = await screen.findByTestId(`oauth-client-row-${client.clientId}`);
    await waitFor(() => expect(api.fetchOAuthClientStats).toHaveBeenCalled());
    expect(row).toHaveTextContent('My App');
    expect(screen.queryByTestId(`oauth-client-signups-link-${client.clientId}`)).not.toBeInTheDocument();
  });

  it('shows a dash for a client missing from the stats', async () => {
    api.fetchOAuthClientStats.mockResolvedValue({});
    renderTab();
    const row = await screen.findByTestId(`oauth-client-row-${client.clientId}`);
    await waitFor(() => expect(api.fetchOAuthClientStats).toHaveBeenCalled());
    expect(row).toHaveTextContent('\u2014');
    expect(screen.queryByTestId(`oauth-client-signups-link-${client.clientId}`)).not.toBeInTheDocument();
  });

  it('opens the Users tab filtered to the client from the sign-ups link', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId(`oauth-client-signups-link-${client.clientId}`));
    expect(navigate).toHaveBeenCalledWith({
      to: '/admin',
      search: expect.objectContaining({ tab: 'users', signupClient: client.clientId }),
    });
  });
});

describe('OAuthClientsTab rotate and deactivate confirms', () => {
  const open = async (dialog: 'rotate' | 'deactivate') => {
    if (dialog === 'rotate') await openRowAction('rotate');
    else fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
  };

  it.each([
    ['rotate', 'Rotate client secret', 'Rotate secret'],
    ['deactivate', 'Deactivate client', 'Deactivate client'],
  ] as const)(
    'confirms %s in an ActionDialog with a danger commit that waits for a reason it says is not stored',
    async (dialog, title, label) => {
      renderTab();
      await open(dialog);

      expect(screen.getByRole('dialog', { name: title })).toBe(screen.getByTestId(`oauth-client-${dialog}-modal`));
      const confirm = screen.getByTestId(`oauth-client-${dialog}-confirm-btn`);
      expect(confirm).toHaveTextContent(new RegExp(`^${label}$`));
      expect(confirm.className).toContain('MuiButton-colorDanger');
      expect(screen.getByTestId(`oauth-client-${dialog}-modal-reason-input-helper`)).toHaveTextContent(
        'Not stored yet'
      );
      expect(confirm).toBeDisabled();
      pickReason(dialog);
      expect(confirm).toBeEnabled();
    }
  );

  it.each(['rotate', 'deactivate'] as const)('closes the %s dialog from Cancel without a request', async dialog => {
    renderTab();
    await open(dialog);
    pickReason(dialog);

    fireEvent.click(screen.getByTestId(`oauth-client-${dialog}-modal-cancel-btn`));
    await waitFor(() => expect(screen.queryByTestId(`oauth-client-${dialog}-modal`)).not.toBeInTheDocument());
    expect(api.rotateOAuthClientSecret).not.toHaveBeenCalled();
    expect(api.updateOAuthClient).not.toHaveBeenCalled();
    expect(screen.getByTestId('oauth-client-toggle-b4m_my_app_0011aabb')).toBeChecked();
  });
});

describe('OAuthClientsTab page frame', () => {
  const second = { ...client, id: 'c2', clientId: 'b4m_other_app_22ccdd', name: 'Other App' };

  it('opens with the page header: sentence-case h1 with the count, description and the register action', async () => {
    renderTab();
    await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb');
    const header = screen.getByTestId('admin-page-header');

    expect(screen.getByTestId('oauth-clients-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^OAuth clients \(1\)$/);
    expect(header).toHaveTextContent('Apps registered to use "Sign in with Bike4Mind".');
    expect(within(header).getByTestId('oauth-client-add-btn')).toHaveTextContent('Register client');
  });

  it('lists clients in one DataTable that scrolls sideways below its min width, with single-line names', async () => {
    renderTab();
    await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb');

    expect(screen.getByTestId('oauth-clients-table')).toHaveStyle({ minWidth: '85rem' });
    expect(screen.getByTestId('oauth-clients-table-frame').parentElement).toBe(screen.getByTestId('oauth-clients-tab'));
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getByTestId('oauth-clients-table')).toContainElement(
      screen.getByTestId('oauth-client-row-b4m_my_app_0011aabb')
    );
    const name = screen.getByTestId('oauth-client-name-b4m_my_app_0011aabb');
    expect(name).toHaveAttribute('title', 'My App');
    expect(getComputedStyle(name).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
  });

  it('opens the rotate confirmation for the row whose menu was used', async () => {
    api.fetchOAuthClients.mockResolvedValue([client, second]);
    api.rotateOAuthClientSecret.mockResolvedValue({ client: second, clientSecret: SECRET });
    renderTab();
    await openRowAction('rotate', second.clientId);

    const dialog = screen.getByTestId('oauth-client-rotate-modal');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Rotate client secret');
    expect(dialog).toHaveTextContent('Generate a new secret for Other App?');
    pickReason('rotate');
    fireEvent.click(screen.getByTestId('oauth-client-rotate-confirm-btn'));
    await waitFor(() => expect(api.rotateOAuthClientSecret).toHaveBeenCalledWith('c2'));
  });

  it('opens the edit dialog for the row whose menu was used', async () => {
    api.fetchOAuthClients.mockResolvedValue([client, second]);
    renderTab();
    await openRowAction('edit', second.clientId);

    const dialog = screen.getByTestId('oauth-client-edit-modal');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Edit OAuth client');
    expect(dialog).toHaveTextContent('Other App');
  });

  it('names the object on the register and edit commit buttons', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-add-btn'));
    expect(screen.getByTestId('oauth-client-create-submit-btn')).toHaveTextContent(/^Register client$/);
    fireEvent.click(screen.getByTestId('oauth-client-create-modal-close-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-create-modal')).not.toBeInTheDocument());

    await openRowAction('edit');
    expect(screen.getByTestId('oauth-client-edit-save-btn')).toHaveTextContent(/^Save changes$/);
  });

  it('shows an empty state in place of the table whose action opens the register dialog', async () => {
    api.fetchOAuthClients.mockResolvedValue([]);
    renderTab();

    const empty = await screen.findByTestId('oauth-clients-empty');
    expect(within(empty).getByTestId('admin-empty-state')).toHaveTextContent('No OAuth clients registered yet');
    expect(screen.queryByTestId('oauth-clients-table')).not.toBeInTheDocument();
    fireEvent.click(within(empty).getByTestId('oauth-clients-empty-add-btn'));
    expect(await screen.findByTestId('oauth-client-create-modal')).toBeInTheDocument();
  });

  it('keeps the header and shows skeleton rows while clients load', () => {
    api.fetchOAuthClients.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('retries the list from the load error state', async () => {
    api.fetchOAuthClients.mockRejectedValueOnce(new Error('Forbidden'));
    renderTab();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Could not load OAuth clients: Forbidden');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb')).toBeInTheDocument();
    expect(api.fetchOAuthClients).toHaveBeenCalledTimes(2);
  });
});

describe('buildCreatePayload', () => {
  const form = {
    name: 'App',
    redirectUris: 'https://a.example.test/cb',
    postLogoutRedirectUris: ' \n',
    firstParty: true,
    unpaidAccountsAllowed: true,
    federated: {
      enabled: true,
      subjectSource: 'sub' as const,
      issuer: ' https://b4m.example.test ',
      audience: '',
      providerName: 'ignored for sub',
      jwksUri: 'https://b4m.example.test/api/oauth/jwks',
    },
  };

  it('makes first-party an explicit opt-in and drops blank and inapplicable federated fields', () => {
    expect(buildCreatePayload(form)).toEqual({
      name: 'App',
      redirectUris: ['https://a.example.test/cb'],
      clientType: 'first-party',
      federatedIdp: {
        subjectSource: 'sub',
        issuer: 'https://b4m.example.test',
        audience: undefined,
        jwksUri: 'https://b4m.example.test/api/oauth/jwks',
      },
    });
  });

  it('sends the federated object even when every field is blank, so the server can reject it', () => {
    const payload = buildCreatePayload({
      ...form,
      federated: { ...form.federated, issuer: '', jwksUri: '', providerName: '', subjectSource: 'identities' },
    });
    expect(payload.federatedIdp).toEqual({
      subjectSource: 'identities',
      issuer: undefined,
      audience: undefined,
      jwksUri: undefined,
      providerName: undefined,
    });
  });

  it('sends unpaidAccountsAllowed false only for a federated client that opts out', () => {
    expect(buildCreatePayload({ ...form, unpaidAccountsAllowed: false }).unpaidAccountsAllowed).toBe(false);
    expect(buildCreatePayload(form)).not.toHaveProperty('unpaidAccountsAllowed');
    const off = { ...form, unpaidAccountsAllowed: false, federated: { ...form.federated, enabled: false } };
    expect(buildCreatePayload(off)).not.toHaveProperty('unpaidAccountsAllowed');
  });

  it('splits redirect URIs on newlines only, so a comma in a query string stays in one entry', () => {
    const payload = buildCreatePayload({
      ...form,
      redirectUris: ' https://a.example.test/cb?x=1,2 \n\n https://a.example.test/other ',
    });
    expect(payload.redirectUris).toEqual(['https://a.example.test/cb?x=1,2', 'https://a.example.test/other']);
  });

  it('omits the trust config entirely when federation is off', () => {
    const payload = buildCreatePayload({
      ...form,
      firstParty: false,
      federated: { ...form.federated, enabled: false },
    });
    expect(payload).toEqual({ name: 'App', redirectUris: ['https://a.example.test/cb'], clientType: 'relying-party' });
  });
});

describe('edit modal scopes and federated trust', () => {
  const idp = {
    subjectSource: 'sub' as const,
    issuer: 'https://b4m.example.test',
    audience: client.clientId,
    jwksUri: 'https://b4m.example.test/api/oauth/jwks',
  };
  const federatedClient = {
    ...client,
    allowedScopes: [...client.allowedScopes, 'ai:generate', 'me:read'],
    federatedIdp: idp,
  };
  const openEdit = async () => {
    renderTab();
    await openRowAction('edit');
  };
  const scopeBox = (scope: string) => screen.getByTestId(`oauth-client-edit-scope-${scope}`) as HTMLInputElement;

  it('prefills scopes and trust config', async () => {
    api.fetchOAuthClients.mockResolvedValue([federatedClient]);
    await openEdit();
    expect(scopeBox('email').checked).toBe(true);
    expect(scopeBox('ai:generate').checked).toBe(true);
    expect(scopeBox('federated:admin-status').checked).toBe(false);
    expect(scopeBox('openid').disabled).toBe(true);
    expect((screen.getByTestId('oauth-client-edit-federated-switch') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('oauth-client-edit-federated-issuer-input')).toHaveValue(idp.issuer);
  });

  it('shows the unpaid-accounts toggle on for a federated client and saves an opt-out', async () => {
    api.fetchOAuthClients.mockResolvedValue([federatedClient]);
    api.updateOAuthClient.mockResolvedValue(federatedClient);
    await openEdit();
    const toggle = screen.getByTestId('oauth-client-edit-unpaid-accounts-switch') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        unpaidAccountsAllowed: false,
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('shows the toggle off for a stored opt-out', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...federatedClient, unpaidAccountsAllowed: false }]);
    await openEdit();
    expect((screen.getByTestId('oauth-client-edit-unpaid-accounts-switch') as HTMLInputElement).checked).toBe(false);
  });

  it('does not offer the unpaid-accounts toggle when the client is not federated', async () => {
    await openEdit();
    expect(screen.queryByTestId('oauth-client-edit-unpaid-accounts-switch')).toBeNull();
  });

  it('disables the opt-in scope unless the client is federated and relying-party', async () => {
    await openEdit();
    expect(scopeBox('federated:admin-status').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('oauth-client-edit-federated-switch'));
    expect(scopeBox('federated:admin-status').disabled).toBe(false);
  });

  it('keeps the opt-in scope disabled for a first-party client', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...federatedClient, clientType: 'first-party' }]);
    await openEdit();
    expect(scopeBox('federated:admin-status').disabled).toBe(true);
  });

  it('keeps a ticked opt-in scope untickable after federation is switched off', async () => {
    api.fetchOAuthClients.mockResolvedValue([
      { ...federatedClient, allowedScopes: [...federatedClient.allowedScopes, 'federated:admin-status'] },
    ]);
    await openEdit();
    fireEvent.click(screen.getByTestId('oauth-client-edit-federated-switch'));
    expect(scopeBox('federated:admin-status').disabled).toBe(false);
    expect(scopeBox('federated:admin-status').checked).toBe(true);
  });

  it('pre-ticks ai:generate and me:read when federation is turned on', async () => {
    await openEdit();
    expect(scopeBox('ai:generate').checked).toBe(false);
    fireEvent.click(screen.getByTestId('oauth-client-edit-federated-switch'));
    expect(scopeBox('ai:generate').checked).toBe(true);
    expect(scopeBox('me:read').checked).toBe(true);
  });

  it('confirms before removing a scope, and cancel sends no request', async () => {
    api.updateOAuthClient.mockResolvedValue(client);
    await openEdit();
    fireEvent.click(scopeBox('email'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    const modal = await screen.findByTestId('oauth-client-edit-narrow-modal');
    expect(modal).toHaveTextContent('email');
    expect(modal).toHaveTextContent('invalid_scope');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: false }));
    expect(api.updateOAuthClient).not.toHaveBeenCalled();
  });

  it('sends the narrowed scopes once the removal is confirmed', async () => {
    api.updateOAuthClient.mockResolvedValue(client);
    await openEdit();
    fireEvent.click(scopeBox('email'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    fireEvent.click(await screen.findByTestId('oauth-client-edit-narrow-confirm-btn'));
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        allowedScopes: ['openid', 'profile'],
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('sends the loaded updatedAt with a scope-only save', async () => {
    api.updateOAuthClient.mockResolvedValue(client);
    await openEdit();
    fireEvent.click(scopeBox('federated:admin-status'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalled());
    expect(api.updateOAuthClient.mock.calls[0][1]).toMatchObject({ expectedUpdatedAt: client.updatedAt });
  });

  it('sends federatedIdp null when federation is turned off', async () => {
    api.fetchOAuthClients.mockResolvedValue([federatedClient]);
    api.updateOAuthClient.mockResolvedValue(client);
    await openEdit();
    fireEvent.click(screen.getByTestId('oauth-client-edit-federated-switch'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    fireEvent.click(await screen.findByTestId('oauth-client-edit-narrow-confirm-btn'));
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        federatedIdp: null,
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('confirms before turning federation off, and cancel sends no request', async () => {
    api.fetchOAuthClients.mockResolvedValue([federatedClient]);
    api.updateOAuthClient.mockResolvedValue(client);
    await openEdit();
    fireEvent.click(screen.getByTestId('oauth-client-edit-federated-switch'));
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    const modal = await screen.findByTestId('oauth-client-edit-narrow-modal');
    expect(modal).toHaveTextContent('stops the AI-token exchange');
    expect(modal).not.toHaveTextContent('invalid_scope');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', hidden: false }));
    expect(api.updateOAuthClient).not.toHaveBeenCalled();
  });

  it('closes without a request when nothing changed', async () => {
    await openEdit();
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    await waitFor(() => expect(screen.queryByTestId('oauth-client-edit-modal')).not.toBeInTheDocument());
    expect(api.updateOAuthClient).not.toHaveBeenCalled();
  });
});

describe('buildEditPayload', () => {
  const stored = { ...client, allowedScopes: ['openid', 'legacy:x'] } as never;

  it('sends post-logout redirect URIs only when they changed', () => {
    const withUris = { ...client, postLogoutRedirectUris: ['https://n.example.test/out'] } as never;
    const form = editFormFromClient(withUris);
    expect(form.postLogoutRedirectUris).toBe('https://n.example.test/out');
    expect(buildEditPayload(withUris, form)).toEqual({});
    expect(buildEditPayload(withUris, { ...form, postLogoutRedirectUris: '' })).toEqual({ postLogoutRedirectUris: [] });
    expect(
      buildEditPayload(stored, { ...editFormFromClient(stored), postLogoutRedirectUris: 'https://x.example.test/o' })
    ).toEqual({
      postLogoutRedirectUris: ['https://x.example.test/o'],
    });
  });

  it('sends only the changed fields', () => {
    const form = editFormFromClient(stored);
    expect(buildEditPayload(stored, form)).toEqual({});
    expect(buildEditPayload(stored, { ...form, redirectUris: 'https://n.example.test/cb' })).toEqual({
      redirectUris: ['https://n.example.test/cb'],
    });
  });

  it('sets, changes and clears the Overwatch product, and sends nothing when it is unchanged', () => {
    const form = editFormFromClient(stored);
    expect(form.overwatchProductId).toBe('');
    expect(buildEditPayload(stored, { ...form, overwatchProductId: ' reading-app ' })).toEqual({
      overwatchProductId: 'reading-app',
    });

    const withProduct = { ...client, overwatchProductId: 'reading-app' } as never;
    const productForm = editFormFromClient(withProduct);
    expect(buildEditPayload(withProduct, productForm)).toEqual({});
    expect(buildEditPayload(withProduct, { ...productForm, overwatchProductId: 'other-app' })).toEqual({
      overwatchProductId: 'other-app',
    });
    expect(buildEditPayload(withProduct, { ...productForm, overwatchProductId: '' })).toEqual({
      overwatchProductId: null,
    });
  });

  it('keeps a legacy scope that is still ticked and appends new ones in catalogue order', () => {
    const form = editFormFromClient(stored);
    expect(buildEditPayload(stored, { ...form, scopes: ['me:read', 'email', 'legacy:x', 'openid'] })).toEqual({
      allowedScopes: ['openid', 'legacy:x', 'email', 'me:read'],
    });
  });
});

describe('federatedFormFromClient', () => {
  it('reads a stored config without subjectSource as the identities shape', () => {
    const form = federatedFormFromClient({
      ...client,
      federatedIdp: { issuer: 'https://i.example.test', audience: 'a', providerName: 'p' },
    } as never);
    expect(form).toMatchObject({ enabled: true, subjectSource: 'identities', providerName: 'p' });
  });
});

describe('unpaid account limits', () => {
  const idp = {
    subjectSource: 'sub' as const,
    issuer: 'https://b4m.example.test',
    audience: client.clientId,
    jwksUri: 'https://b4m.example.test/api/oauth/jwks',
  };
  const federated = {
    ...client,
    allowedScopes: [...client.allowedScopes, 'ai:generate', 'me:read'],
    federatedIdp: idp,
  };
  const limits = { requestsPerMinute: 30, requestsPerDay: 600, tokensPerMinute: 400000, maxConcurrent: 4 };
  const withLimits = { ...federated, unpaidAccountLimits: limits };
  const id = (name: string) => `oauth-client-edit-unpaid-limits-${name}`;
  const input = (name: string) => screen.getByTestId(id(`${name}-input`)) as HTMLInputElement;
  const sw = () => screen.getByTestId(id('switch')) as HTMLInputElement;
  const save = () => fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
  const open = async (c: object) => {
    api.fetchOAuthClients.mockResolvedValue([c]);
    api.updateOAuthClient.mockResolvedValue(c);
    renderTab();
    await openRowAction('edit');
  };

  it('shows the switch off with the global line, prefills globals when turned on, and saves the object', async () => {
    adminSettings.values.apiKeyUntrustedRateLimitPerMin = 25;
    await open(federated);
    expect(sw().checked).toBe(false);
    expect(screen.getByTestId(id('global-text'))).toHaveTextContent(
      'Using global limits: 25/min, no daily limit, no token limit, no concurrency limit.'
    );
    expect(screen.queryByTestId(id('rpm-input'))).toBeNull();
    fireEvent.click(sw());
    expect(input('rpm')).toHaveValue('25');
    expect(input('rpd')).toHaveValue('0');
    save();
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        unpaidAccountLimits: { requestsPerMinute: 25, requestsPerDay: 0, tokensPerMinute: 0, maxConcurrent: 0 },
        expectedUpdatedAt: client.updatedAt,
      })
    );
    adminSettings.values.apiKeyUntrustedRateLimitPerMin = 20;
  });

  it('shows stored limits formatted and saves the full object after one edit', async () => {
    await open(withLimits);
    expect(sw().checked).toBe(true);
    expect(input('tpm')).toHaveValue('400,000');
    fireEvent.change(input('rpd'), { target: { value: '1000' } });
    fireEvent.blur(input('rpd'));
    expect(input('rpd')).toHaveValue('1,000');
    save();
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        unpaidAccountLimits: { ...limits, requestsPerDay: 1000 },
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('sends null when the switch is turned off on a stored override', async () => {
    await open(withLimits);
    fireEvent.click(sw());
    save();
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        unpaidAccountLimits: null,
        expectedUpdatedAt: client.updatedAt,
      })
    );
  });

  it('omits unpaidAccountLimits on an unrelated edit', async () => {
    await open(withLimits);
    fireEvent.change(screen.getByTestId('oauth-client-edit-overwatch-product-input'), { target: { value: 'app' } });
    save();
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalled());
    expect(api.updateOAuthClient.mock.calls[0][1]).not.toHaveProperty('unpaidAccountLimits');
  });

  it('disables the controls and shows the hint when unpaid accounts are not allowed, without changing the stored override', async () => {
    await open({ ...withLimits, unpaidAccountsAllowed: false });
    expect(sw().disabled).toBe(true);
    expect(input('rpm').disabled).toBe(true);
    expect(screen.getByTestId(id('disabled-hint'))).toHaveTextContent(
      'Unpaid accounts cannot use this app. Turn on "Starter and free accounts may use this app" for these limits to apply.'
    );
    fireEvent.change(screen.getByTestId('oauth-client-edit-overwatch-product-input'), { target: { value: 'app' } });
    save();
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalled());
    expect(api.updateOAuthClient.mock.calls[0][1]).not.toHaveProperty('unpaidAccountLimits');
  });

  it.each([
    ['rpm', '0', 'Must be between 1 and 10,000'],
    ['rpm', '', 'Enter a whole number'],
    ['rpd', '12a', 'Enter a whole number'],
    ['rpd', '1000001', 'Must be between 0 and 1,000,000'],
    ['tpm', '100000001', 'Must be between 0 and 100,000,000'],
    ['concurrent', '1001', 'Must be between 0 and 1,000'],
  ])('flags %s=%j and disables Save', async (name, text, message) => {
    await open(withLimits);
    fireEvent.change(input(name), { target: { value: text } });
    expect(input(name).closest('.MuiFormControl-root')).toHaveTextContent(message);
    expect(screen.getByTestId('oauth-client-edit-save-btn')).toBeDisabled();
  });

  it('accepts 0 tokens per minute', async () => {
    await open(withLimits);
    fireEvent.change(input('tpm'), { target: { value: '0' } });
    expect(screen.getByTestId('oauth-client-edit-save-btn')).not.toBeDisabled();
  });

  it('is hidden when federated trust is off', async () => {
    await open(client);
    expect(screen.queryByTestId('oauth-client-edit-unpaid-limits-section')).toBeNull();
  });

  it('shows no global line or placeholders before settings load', async () => {
    adminSettings.loaded = false;
    await open(federated);
    expect(screen.queryByTestId(id('global-text'))).toBeNull();
    fireEvent.click(sw());
    expect(input('rpm')).toHaveValue('20');
    expect(input('rpm')).not.toHaveAttribute('placeholder');
  });

  it('notes when the trust gate is off', async () => {
    adminSettings.trustGate = false;
    await open(federated);
    expect(screen.getByTestId(id('trust-gate-text'))).toHaveTextContent(
      'The API key trust gate is off, so no account is limited as unpaid.'
    );
  });

  it('renders the row chip only for clients with limits', async () => {
    api.fetchOAuthClients.mockResolvedValue([withLimits, { ...client, id: 'c2', clientId: 'other' }]);
    renderTab();
    const chip = await screen.findByTestId(`oauth-client-unpaid-limits-chip-${client.clientId}`);
    expect(chip).toHaveAttribute('title', '30/min, 600/day, 400,000 tokens/min, 4 at once');
    expect(screen.queryByTestId('oauth-client-unpaid-limits-chip-other')).toBeNull();
  });
});

describe('unpaid limits payload', () => {
  const limits = { requestsPerMinute: 30, requestsPerDay: 600, tokensPerMinute: 400000, maxConcurrent: 4 };
  const federated = {
    ...client,
    federatedIdp: {
      subjectSource: 'sub' as const,
      issuer: 'https://b4m.example.test',
      audience: client.clientId,
      jwksUri: 'https://b4m.example.test/api/oauth/jwks',
    },
  } as never;
  const base = { ...(federated as object), unpaidAccountLimits: limits } as never;

  it('reads stored limits into the form', () => {
    expect(editFormFromClient(base).unpaidLimits).toEqual({
      enabled: true,
      rpm: '30',
      rpd: '600',
      tpm: '400,000',
      concurrent: '4',
    });
    expect(editFormFromClient(federated).unpaidLimits).toMatchObject({ enabled: false, rpm: '20' });
  });

  it('sends the full object only when it differs from stored', () => {
    const form = editFormFromClient(base);
    expect(buildEditPayload(base, form)).toEqual({});
    expect(buildEditPayload(base, { ...form, unpaidLimits: { ...form.unpaidLimits, concurrent: '5' } })).toEqual({
      unpaidAccountLimits: { ...limits, maxConcurrent: 5 },
    });
    const fresh = editFormFromClient(federated);
    expect(buildEditPayload(federated, { ...fresh, unpaidLimits: { ...fresh.unpaidLimits, enabled: true } })).toEqual({
      unpaidAccountLimits: { requestsPerMinute: 20, requestsPerDay: 0, tokensPerMinute: 0, maxConcurrent: 0 },
    });
  });

  it('sends null when a stored override is switched off and omits the field when nothing is stored', () => {
    const form = editFormFromClient(base);
    expect(buildEditPayload(base, { ...form, unpaidLimits: { ...form.unpaidLimits, enabled: false } })).toEqual({
      unpaidAccountLimits: null,
    });
    expect(buildEditPayload(federated, editFormFromClient(federated))).toEqual({});
  });

  it('drops the override along with federation, since the server refuses it on a non-federated client', () => {
    const form = editFormFromClient(base);
    expect(buildEditPayload(base, { ...form, federated: { ...form.federated, enabled: false } })).toEqual({
      federatedIdp: null,
      unpaidAccountLimits: null,
    });
    const fresh = editFormFromClient(federated);
    expect(
      buildEditPayload(federated, {
        ...fresh,
        federated: { ...fresh.federated, enabled: false },
        unpaidLimits: { ...fresh.unpaidLimits, enabled: true },
      })
    ).toEqual({ federatedIdp: null });
  });
});
