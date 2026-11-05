import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const { api, copy } = vi.hoisted(() => ({
  api: {
    fetchOAuthClients: vi.fn(),
    createOAuthClient: vi.fn(),
    updateOAuthClient: vi.fn(),
    rotateOAuthClientSecret: vi.fn(),
  },
  copy: vi.fn(),
}));

vi.mock('@client/app/utils/oauthClientAPICalls', () => api);
vi.mock('@client/app/hooks/useCopyToClipboard', () => ({
  useCopyToClipboard: () => ({ copied: false, handleCopyToClipboard: copy }),
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

beforeEach(() => {
  // Not resetAllMocks: that also wipes global setup mocks (matchMedia) the theme provider needs.
  for (const fn of [...Object.values(api), copy, toast.success, toast.error]) vi.mocked(fn).mockReset();
  api.fetchOAuthClients.mockResolvedValue([client]);
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
    fireEvent.click(await screen.findByTestId('oauth-client-rotate-b4m_my_app_0011aabb'));
    expect(api.rotateOAuthClientSecret).not.toHaveBeenCalled();
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
    fireEvent.click(screen.getByTestId('oauth-client-deactivate-confirm-btn'));
    await waitFor(() => expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', { isActive: false }));
  });

  it('edits redirect URIs', async () => {
    api.updateOAuthClient.mockResolvedValue(client);
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-edit-b4m_my_app_0011aabb'));
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
    fireEvent.click(await screen.findByTestId('oauth-client-edit-b4m_my_app_0011aabb'));
    fireEvent.change(screen.getByTestId('oauth-client-edit-uris-input'), {
      target: { value: 'https://x.example.test/cb' },
    });
    fireEvent.click(screen.getByTestId('oauth-client-edit-save-btn'));
    expect(await screen.findByTestId('oauth-client-edit-error')).toHaveTextContent(/must not contain whitespace/);
    expect(screen.getByTestId('oauth-client-edit-modal')).toBeInTheDocument();
    await waitFor(() => expect(api.fetchOAuthClients).toHaveBeenCalledTimes(2));
  });

  it('toasts the error and shows no secret modal when rotation fails', async () => {
    api.rotateOAuthClientSecret.mockRejectedValue(new Error('rotate failed'));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-rotate-b4m_my_app_0011aabb'));
    fireEvent.click(screen.getByTestId('oauth-client-rotate-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('rotate failed'));
    expect(screen.queryByTestId('oauth-client-secret-modal')).not.toBeInTheDocument();
  });

  it('toasts the error when deactivation fails', async () => {
    api.updateOAuthClient.mockRejectedValue(new Error('deactivate failed'));
    renderTab();
    fireEvent.click(await screen.findByTestId('oauth-client-toggle-b4m_my_app_0011aabb'));
    fireEvent.click(screen.getByTestId('oauth-client-deactivate-confirm-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('deactivate failed'));
    expect(screen.getByTestId('oauth-client-deactivate-modal')).toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows a load error instead of the empty state when the list fetch fails', async () => {
    api.fetchOAuthClients.mockRejectedValue(new Error('Forbidden'));
    renderTab();
    expect(await screen.findByTestId('oauth-clients-load-error')).toHaveTextContent(/Forbidden/);
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
    expect(screen.queryByTestId('oauth-clients-load-error')).not.toBeInTheDocument();
  });

  it('hides rotate for a public (PKCE) client', async () => {
    api.fetchOAuthClients.mockResolvedValue([{ ...client, tokenEndpointAuthMethod: 'none' }]);
    renderTab();
    await screen.findByTestId('oauth-client-row-b4m_my_app_0011aabb');
    expect(screen.queryByTestId('oauth-client-rotate-b4m_my_app_0011aabb')).not.toBeInTheDocument();
  });
});

describe('buildCreatePayload', () => {
  const form = {
    name: 'App',
    redirectUris: 'https://a.example.test/cb',
    firstParty: true,
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
    fireEvent.click(await screen.findByTestId('oauth-client-edit-b4m_my_app_0011aabb'));
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
    await waitFor(() =>
      expect(api.updateOAuthClient).toHaveBeenCalledWith('c1', {
        federatedIdp: null,
        expectedUpdatedAt: client.updatedAt,
      })
    );
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

  it('sends only the changed fields', () => {
    const form = editFormFromClient(stored);
    expect(buildEditPayload(stored, form)).toEqual({});
    expect(buildEditPayload(stored, { ...form, redirectUris: 'https://n.example.test/cb' })).toEqual({
      redirectUris: ['https://n.example.test/cb'],
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
