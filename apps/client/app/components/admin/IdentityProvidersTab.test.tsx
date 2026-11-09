import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('IdentityProvidersTab', () => {
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
    expect(tab.querySelectorAll('.MuiCard-root')).toHaveLength(0);
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

  it('deletes the chosen row only after the browser confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderTab();

    await openRowAction('idp-okta', 'delete');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.delete).not.toHaveBeenCalled();

    await openRowAction('idp-okta', 'delete');
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/admin/identity-providers/idp-okta'));
    confirm.mockRestore();
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
