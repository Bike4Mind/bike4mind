import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { getThemeConfig } from '@client/app/utils/themes';

const { api } = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import IdentityProvidersTab from './IdentityProvidersTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <IdentityProvidersTab />
    </CssVarsProvider>
  );

const DEFAULT_SAML = {
  entryPoint: '',
  issuer: '',
  cert: '',
  callbackUrl: '',
  identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  attributeMappings: { email: 'email', firstName: 'firstName', lastName: 'lastName', name: 'name' },
};
const DEFAULT_OKTA = { audience: '', clientId: '', clientSecret: '', authServerId: '', useOrgAuthServer: false };

const samlIdp = {
  id: 'idp-saml',
  name: 'Example Workforce Single Sign-On',
  emailDomain: 'example.com',
  type: 'saml',
  isActive: true,
  samlConfig: { ...DEFAULT_SAML, entryPoint: 'https://idp.example.test/sso', issuer: 'https://idp.example.test' },
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};
const oktaIdp = {
  id: 'idp-okta',
  name: 'Example Okta',
  emailDomain: 'example.org',
  type: 'okta',
  isActive: false,
  oktaConfig: { ...DEFAULT_OKTA, audience: 'https://example.okta.test', clientId: 'okta-client' },
  hasSecrets: { clientSecret: true },
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
};

const openRowAction = async (idpId: string, action: 'edit' | 'sp-metadata' | 'delete') => {
  fireEvent.click(await screen.findByTestId(`identity-provider-actions-${idpId}`));
  fireEvent.click(await screen.findByTestId(`identity-provider-${action}-${idpId}`));
};

const DELETE = 'identity-provider-delete-dialog';
const openDelete = async (idpId = oktaIdp.id) => {
  await openRowAction(idpId, 'delete');
  return screen.findByTestId(DELETE);
};
const fillDelete = (typed: string) => {
  fireEvent.click(screen.getByTestId(`${DELETE}-reason-input-preset-0`));
  fireEvent.change(screen.getByTestId(`${DELETE}-typed-input`), { target: { value: typed } });
};

describe('IdentityProvidersTab', () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    for (const fn of [...Object.values(api), toast.success, toast.error]) vi.mocked(fn).mockReset();
    api.get.mockResolvedValue({ data: [samlIdp, oktaIdp] });
    api.post.mockResolvedValue({ data: {} });
    api.put.mockResolvedValue({ data: {} });
    api.delete.mockResolvedValue({ data: {} });
  });

  it('opens with the page header: sentence-case h1 with the count, description, help and the add action', async () => {
    renderTab();
    await screen.findByTestId('identity-provider-row-idp-saml');
    const header = screen.getByTestId('admin-page-header');

    expect(screen.getByTestId('admin-identity-providers-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Identity providers \(2\)$/);
    expect(header).toHaveTextContent('SAML and Okta single sign-on');
    expect(within(header).getByTestId('help-button-admin-identity-providers')).toBeInTheDocument();
    expect(within(header).getByTestId('identity-provider-add-btn')).toHaveTextContent('Add identity provider');
  });

  it('lists providers in one DataTable that scrolls sideways below its min width, with single-line names', async () => {
    renderTab();
    await screen.findByTestId('identity-provider-row-idp-saml');
    const tab = screen.getByTestId('admin-identity-providers-tab');

    expect(screen.getByTestId('identity-providers-table')).toHaveStyle({ minWidth: '44rem' });
    expect(screen.getByTestId('identity-providers-table-frame').parentElement).toBe(tab);
    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(
      within(screen.getByTestId('identity-providers-table')).getAllByTestId(/^identity-provider-row-/)
    ).toHaveLength(2);
    const name = screen.getByTestId('identity-provider-name-idp-saml');
    expect(name).toHaveTextContent(samlIdp.name);
    expect(name).toHaveAttribute('title', samlIdp.name);
    expect(getComputedStyle(name).whiteSpace).toBe('nowrap');
    expect(getComputedStyle(name).textOverflow).toBe('ellipsis');
  });

  it('shows every provider without a pager, as before', async () => {
    const many = Array.from({ length: 26 }, (_, index) => ({
      ...samlIdp,
      id: `idp-${index + 1}`,
      name: `Provider ${index + 1}`,
      emailDomain: `example-${index + 1}.com`,
    }));
    api.get.mockResolvedValue({ data: many });
    renderTab();

    expect(await screen.findByTestId('identity-provider-row-idp-26')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^identity-provider-row-/)).toHaveLength(26);
    expect(screen.queryByTestId('admin-table-footer')).not.toBeInTheDocument();
  });

  it('shows status with the admin tones: active is good, inactive is neutral', async () => {
    renderTab();
    expect(await screen.findByTestId('identity-provider-status-idp-saml')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('identity-provider-status-idp-saml')).toHaveTextContent('Active');
    expect(screen.getByTestId('identity-provider-status-idp-okta')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('identity-provider-status-idp-okta')).toHaveTextContent('Inactive');
  });

  it('opens the SP metadata dialog for the chosen SAML row from its row menu', async () => {
    renderTab();
    await openRowAction('idp-saml', 'sp-metadata');

    const dialog = await screen.findByTestId('identity-provider-sp-metadata-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Service provider metadata');
    expect(dialog).toHaveTextContent(`Use these values to configure ${samlIdp.name}`);
    expect(dialog).toHaveTextContent('idp=idp-saml');
  });

  it('closes the SP metadata dialog from its Close button', async () => {
    renderTab();
    await openRowAction('idp-saml', 'sp-metadata');
    await screen.findByTestId('identity-provider-sp-metadata-dialog');

    fireEvent.click(screen.getByTestId('identity-provider-sp-metadata-close-btn'));
    await waitFor(() => expect(screen.queryByTestId('identity-provider-sp-metadata-dialog')).not.toBeInTheDocument());
  });

  it('offers no SP metadata item for an Okta row', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('identity-provider-actions-idp-okta'));
    expect(await screen.findByTestId('identity-provider-edit-idp-okta')).toBeInTheDocument();
    expect(screen.queryByTestId('identity-provider-sp-metadata-idp-okta')).not.toBeInTheDocument();
  });

  it('edits the chosen row and sends the same payload to the same endpoint', async () => {
    renderTab();
    await openRowAction('idp-saml', 'edit');

    const dialog = await screen.findByTestId('identity-provider-form-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Edit identity provider');
    expect(screen.getByTestId('identity-provider-name-input')).toHaveValue(samlIdp.name);
    fireEvent.change(screen.getByTestId('identity-provider-name-input'), { target: { value: 'Renamed SSO' } });
    fireEvent.click(screen.getByTestId('identity-provider-form-submit-btn'));

    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/admin/identity-providers/idp-saml', {
        name: 'Renamed SSO',
        emailDomain: 'example.com',
        type: 'saml',
        isActive: true,
        samlConfig: samlIdp.samlConfig,
        oktaConfig: DEFAULT_OKTA,
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Identity provider updated');
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('adds a provider from the header action with the default SAML and Okta config', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('identity-provider-add-btn'));

    const dialog = await screen.findByTestId('identity-provider-form-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent('Add identity provider');
    fireEvent.change(screen.getByTestId('identity-provider-name-input'), { target: { value: 'New SSO' } });
    fireEvent.change(screen.getByTestId('identity-provider-domain-input'), { target: { value: 'example.net' } });
    fireEvent.click(screen.getByTestId('identity-provider-form-submit-btn'));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/admin/identity-providers', {
        name: 'New SSO',
        emailDomain: 'example.net',
        type: 'saml',
        isActive: true,
        samlConfig: DEFAULT_SAML,
        oktaConfig: DEFAULT_OKTA,
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Identity provider created');
  });

  it('keeps the form open with the server error when saving fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.put.mockRejectedValue({ response: { data: { error: 'Email domain is already in use' } } });
    renderTab();
    await openRowAction('idp-saml', 'edit');
    await screen.findByTestId('identity-provider-form-dialog');

    fireEvent.click(screen.getByTestId('identity-provider-form-submit-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Email domain is already in use'));
    expect(screen.getByTestId('identity-provider-form-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('identity-provider-name-input')).toHaveValue(samlIdp.name);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('closes the form from Cancel without a request', async () => {
    renderTab();
    fireEvent.click(await screen.findByTestId('identity-provider-add-btn'));
    await screen.findByTestId('identity-provider-form-dialog');
    fireEvent.change(screen.getByTestId('identity-provider-name-input'), { target: { value: 'Draft SSO' } });

    fireEvent.click(screen.getByTestId('identity-provider-form-cancel-btn'));
    await waitFor(() => expect(screen.queryByTestId('identity-provider-form-dialog')).not.toBeInTheDocument());
    expect(api.post).not.toHaveBeenCalled();
    expect(api.put).not.toHaveBeenCalled();
  });

  it('confirms a delete in a dialog that names the provider, its domain and the loss of single sign-on', async () => {
    renderTab();
    const dialog = await openDelete();

    expect(screen.getByRole('dialog', { name: 'Delete identity provider' })).toBe(dialog);
    expect(dialog).toHaveTextContent(`Deletes ${oktaIdp.name} and its configuration.`);
    expect(dialog).toHaveTextContent(`Users whose email domain is ${oktaIdp.emailDomain} lose single sign-on.`);
    expect(dialog).toHaveTextContent('This cannot be undone.');
    expect(screen.getByTestId(`${DELETE}-typed-expected`)).toHaveTextContent(oktaIdp.name);
    expect(screen.getByTestId(`${DELETE}-reason-input-helper`)).toHaveTextContent('Not stored yet');
    const confirm = screen.getByTestId(`${DELETE}-confirm-btn`);
    expect(confirm).toHaveTextContent(/^Delete provider$/);
    expect(confirm.className).toContain('MuiButton-colorDanger');
  });

  it('unlocks Delete provider only with a reason and the exact name, then sends the same DELETE', async () => {
    api.get.mockResolvedValueOnce({ data: [samlIdp, oktaIdp] }).mockResolvedValueOnce({ data: [samlIdp] });
    renderTab();
    await openDelete();
    const confirm = screen.getByTestId(`${DELETE}-confirm-btn`);
    expect(confirm).toBeDisabled();

    fillDelete('Example');
    expect(confirm).toBeDisabled();
    expect(screen.getByTestId(`${DELETE}-hint`)).toHaveTextContent('Type the provider name exactly to confirm.');
    fireEvent.change(screen.getByTestId(`${DELETE}-typed-input`), { target: { value: oktaIdp.name } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/admin/identity-providers/idp-okta'));
    expect(api.delete).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Identity provider deleted');
    await waitFor(() => expect(screen.queryByTestId(DELETE)).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId('identity-provider-row-idp-okta')).not.toBeInTheDocument());
    expect(screen.getByTestId('identity-provider-row-idp-saml')).toBeInTheDocument();
  });

  it('matches the typed name against the stored name without its stray whitespace', async () => {
    api.get.mockResolvedValue({ data: [{ ...oktaIdp, name: '  Padded SSO ' }] });
    renderTab();
    await openDelete();

    fillDelete('Padded SSO');
    expect(screen.getByTestId(`${DELETE}-confirm-btn`)).toBeEnabled();
  });

  it('keeps the row and sends nothing when the delete is cancelled', async () => {
    renderTab();
    await openDelete();
    fillDelete(oktaIdp.name);

    fireEvent.click(screen.getByTestId(`${DELETE}-cancel-btn`));
    await waitFor(() => expect(screen.queryByTestId(DELETE)).not.toBeInTheDocument());
    expect(api.delete).not.toHaveBeenCalled();
    expect(screen.getByTestId('identity-provider-row-idp-okta')).toBeInTheDocument();
  });

  it('keeps the delete dialog open with the server error when the delete fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.delete.mockRejectedValue({ response: { data: { error: 'Identity provider not found' } } });
    renderTab();
    await openDelete();
    fillDelete(oktaIdp.name);

    fireEvent.click(screen.getByTestId(`${DELETE}-confirm-btn`));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Identity provider not found'));
    expect(screen.getByTestId(DELETE)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId(`${DELETE}-confirm-btn`)).toBeEnabled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('identity-provider-row-idp-okta')).toBeInTheDocument();
  });

  it('shows an empty state in place of the table whose action opens the add dialog', async () => {
    api.get.mockResolvedValue({ data: [] });
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No identity providers yet');
    expect(screen.queryByTestId('identity-providers-table')).not.toBeInTheDocument();
    fireEvent.click(within(empty).getByTestId('identity-provider-empty-add-btn'));
    expect(await screen.findByTestId('identity-provider-form-dialog')).toBeInTheDocument();
  });

  it('keeps the header and shows skeleton rows while providers load', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(screen.getByTestId('admin-page-header')).toBeInTheDocument();
    expect(screen.getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
  });

  it('shows an error state whose retry loads the providers again', async () => {
    api.get.mockRejectedValueOnce(new Error('Forbidden'));
    renderTab();

    expect(await screen.findByTestId('admin-error-state')).toHaveTextContent('Could not load identity providers.');
    fireEvent.click(screen.getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('identity-provider-row-idp-saml')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
