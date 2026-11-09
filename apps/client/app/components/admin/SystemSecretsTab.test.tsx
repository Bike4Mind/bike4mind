import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@client/app/contexts/ApiContext', () => ({
  api: { get: mocks.get, post: mocks.post, delete: mocks.delete },
}));
vi.mock('@client/app/components/help/ContextHelpButton', () => ({ default: () => null }));
vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import SystemSecretsTab from './SystemSecretsTab';

const appTheme = extendTheme({ ...getThemeConfig() });

const TIER1 = {
  stage: 'preview-42',
  secrets: [
    { name: 'JWT_SECRET', status: 'configured', blocksDeploy: false },
    {
      name: 'SESSION_SECRET',
      status: 'placeholder',
      blocksDeploy: false,
      message: 'Still the example value',
      hint: 'npx sst secret set SessionSecret <value>',
    },
    { name: 'RATE_LIMIT_INGEST_TOKEN', status: 'placeholder', blocksDeploy: true },
    { name: 'MONGODB_URI', status: 'missing', blocksDeploy: true },
    { name: 'SECRET_ENCRYPTION_KEY', status: 'warning', blocksDeploy: false },
  ],
};

const SECRETS = {
  tier1Note: '',
  secrets: [
    {
      secretName: 'SLACK_SIGNING_SECRET',
      category: 'slack',
      description: 'Verifies requests from Slack',
      isConfigured: false,
      source: null,
      maskedValue: '',
      isOverridable: true,
      dbRecord: null,
      warnings: ['Value failed to decrypt'],
    },
    {
      secretName: 'SMTP_PASSWORD',
      category: 'mail',
      description: 'Password for the outbound mail server',
      isConfigured: true,
      source: 'database',
      maskedValue: '****abcd',
      isOverridable: true,
      dbRecord: { id: 'db-1', source: 'gui_configured' },
    },
    {
      secretName: 'GOOGLE_CLIENT_SECRET',
      category: 'oauth',
      description: 'Google sign-in client secret',
      isConfigured: true,
      source: 'sst',
      maskedValue: '****wxyz',
      isOverridable: true,
      dbRecord: null,
    },
    {
      secretName: 'LEGACY_WEBHOOK_SECRET',
      category: 'legacy',
      description: 'Outside the known categories',
      isConfigured: true,
      source: 'sst',
      maskedValue: '****0000',
      isOverridable: true,
      dbRecord: null,
    },
  ],
};

const TIER1_URL = '/api/admin/system-secrets/tier1-status';
const SECRETS_URL = '/api/admin/system-secrets';

const respondWith = (overrides: Partial<Record<string, () => Promise<unknown>>> = {}) =>
  mocks.get.mockImplementation((url: string) => {
    const override = overrides[url];
    if (override) return override();
    if (url === TIER1_URL) return Promise.resolve({ data: TIER1 });
    if (url === SECRETS_URL) return Promise.resolve({ data: SECRETS });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });

const renderTab = () =>
  render(
    <CssVarsProvider theme={appTheme}>
      <SystemSecretsTab />
    </CssVarsProvider>
  );

const callsTo = (url: string) => mocks.get.mock.calls.filter(([called]) => called === url).length;
const openRowMenu = (name: string) => fireEvent.click(screen.getByTestId(`system-secrets-row-actions-${name}`));

describe('SystemSecretsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respondWith();
    mocks.post.mockResolvedValue({ data: {} });
    mocks.delete.mockResolvedValue({ data: {} });
  });

  it('opens with the page header: a sentence-case h1 and a refresh action', async () => {
    renderTab();

    const header = await screen.findByTestId('admin-page-header');
    expect(screen.getByTestId('admin-system-secrets-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^System secrets$/);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(within(header).getByTestId('system-secrets-refresh-btn')).toHaveTextContent('Refresh');
    await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');
  });

  it('refreshes both lists from the header', async () => {
    renderTab();
    await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');
    await screen.findByTestId('system-secrets-infra-row-JWT_SECRET');

    fireEvent.click(screen.getByTestId('system-secrets-refresh-btn'));

    await waitFor(() => expect(callsTo(TIER1_URL)).toBe(2));
    expect(callsTo(SECRETS_URL)).toBe(2);
  });

  it('puts the secrets in tables, never in raw cards nested in cards', async () => {
    const { container } = renderTab();
    await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');
    await screen.findByTestId('system-secrets-infra-row-JWT_SECRET');

    expect(container.querySelectorAll('.MuiCard-root')).toHaveLength(0);
    expect(screen.getByTestId('system-secrets-infra-table')).toContainElement(
      screen.getByTestId('system-secrets-infra-row-JWT_SECRET')
    );
    expect(screen.getByTestId('system-secrets-infra-title')).toHaveTextContent('Infrastructure secrets (SST)');
    expect(screen.getByTestId('system-secrets-infra-title')).toHaveTextContent('preview-42');
  });

  it('gives placeholders one neutral tone and keeps good and bad for configured and missing', async () => {
    renderTab();

    const placeholder = await screen.findByTestId('system-secrets-infra-status-SESSION_SECRET');
    expect(placeholder).toHaveTextContent('Placeholder');
    expect(placeholder).toHaveAttribute('data-tone', 'neutral');
    expect(placeholder.querySelector('svg')).toBeNull();
    const blockingPlaceholder = screen.getByTestId('system-secrets-infra-status-RATE_LIMIT_INGEST_TOKEN');
    expect(blockingPlaceholder).toHaveAttribute('data-tone', 'neutral');

    expect(screen.getByTestId('system-secrets-infra-status-JWT_SECRET')).toHaveAttribute('data-tone', 'good');
    expect(screen.getByTestId('system-secrets-infra-status-JWT_SECRET')).toHaveTextContent('Configured');
    expect(screen.getByTestId('system-secrets-infra-status-MONGODB_URI')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getByTestId('system-secrets-infra-status-MONGODB_URI')).toHaveTextContent('Missing');
    expect(screen.getByTestId('system-secrets-infra-status-SECRET_ENCRYPTION_KEY')).toHaveAttribute(
      'data-tone',
      'warn'
    );

    expect(screen.getByTestId('system-secrets-infra-row-SESSION_SECRET')).toHaveTextContent(
      'Not required on this stage'
    );
    expect(screen.getByTestId('system-secrets-infra-row-MONGODB_URI')).not.toHaveTextContent(
      'Not required on this stage'
    );
  });

  it("shows the validator's message and hint when a status chip is hovered", async () => {
    renderTab();

    const chip = await screen.findByTestId('system-secrets-infra-status-SESSION_SECRET');
    fireEvent.mouseOver(chip);

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Still the example value');
    const hint = within(tooltip).getByTestId('system-secrets-infra-hint-SESSION_SECRET');
    expect(hint).toHaveTextContent('npx sst secret set SessionSecret <value>');
    expect(getComputedStyle(hint).fontFamily).toContain('--joy-fontFamily-code');
  });

  it('groups the configurable secrets in one table under a header per category, in order', async () => {
    renderTab();

    const table = await screen.findByTestId('system-secrets-table');
    await within(table).findByTestId('system-secrets-row-SMTP_PASSWORD');
    const groups = within(table)
      .getAllByTestId(/^admin-table-group-/)
      .map(group => group.getAttribute('data-testid'));
    expect(groups).toEqual(['admin-table-group-mail', 'admin-table-group-oauth', 'admin-table-group-slack']);
    expect(within(table).getByTestId('system-secrets-group-mail')).toHaveTextContent('Email configuration');
    expect(within(table).getByTestId('system-secrets-group-oauth')).toHaveTextContent('OAuth providers');
    expect(table).toHaveStyle({ minWidth: '56rem' });
  });

  it('lists only the secrets in the five known categories', async () => {
    renderTab();

    const table = await screen.findByTestId('system-secrets-table');
    await within(table).findByTestId('system-secrets-row-SMTP_PASSWORD');
    expect(within(table).queryByTestId('system-secrets-row-LEGACY_WEBHOOK_SECRET')).toBeNull();
    expect(within(table).queryByTestId('admin-table-group-legacy')).toBeNull();
  });

  it('shows where each value comes from in a status chip with one tone each', async () => {
    renderTab();

    const override = await screen.findByTestId('system-secrets-source-SMTP_PASSWORD');
    expect(override).toHaveTextContent('GUI override');
    expect(override).toHaveAttribute('data-tone', 'info');
    expect(screen.getByTestId('system-secrets-source-GOOGLE_CLIENT_SECRET')).toHaveTextContent('SST');
    expect(screen.getByTestId('system-secrets-source-GOOGLE_CLIENT_SECRET')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('system-secrets-source-SLACK_SIGNING_SECRET')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('system-secrets-source-SLACK_SIGNING_SECRET')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByTestId('system-secrets-warning-SLACK_SIGNING_SECRET')).toHaveAttribute('data-tone', 'warn');
  });

  it('keeps secret names on one line, truncated', async () => {
    renderTab();

    const name = await screen.findByTestId('system-secrets-name-SMTP_PASSWORD');
    expect(name).toHaveStyle({ whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' });
    expect(await screen.findByTestId('system-secrets-infra-name-JWT_SECRET')).toHaveStyle({ whiteSpace: 'nowrap' });
  });

  it('moves Edit and Delete off the row into its "..." menu', async () => {
    renderTab();

    const row = await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');
    expect(within(row).queryByRole('button', { name: /edit secret/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: /delete database override/i })).toBeNull();

    openRowMenu('SMTP_PASSWORD');
    expect(await screen.findByTestId('system-secrets-row-edit-SMTP_PASSWORD')).toHaveTextContent('Edit value');
    expect(screen.getByTestId('system-secrets-row-delete-SMTP_PASSWORD')).toHaveTextContent('Delete override');
  });

  it('offers Delete override only on a secret with a database override', async () => {
    renderTab();
    await screen.findByTestId('system-secrets-row-GOOGLE_CLIENT_SECRET');

    openRowMenu('GOOGLE_CLIENT_SECRET');
    expect(await screen.findByTestId('system-secrets-row-edit-GOOGLE_CLIENT_SECRET')).toBeInTheDocument();
    expect(screen.queryByTestId('system-secrets-row-delete-GOOGLE_CLIENT_SECRET')).toBeNull();
  });

  it('saves a new value from the edit dialog with the same payload', async () => {
    renderTab();
    await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');

    openRowMenu('SMTP_PASSWORD');
    fireEvent.click(await screen.findByTestId('system-secrets-row-edit-SMTP_PASSWORD'));

    const dialog = await screen.findByTestId('system-secrets-edit-dialog');
    expect(within(dialog).getByRole('heading', { level: 2 })).toHaveTextContent(/^Edit value$/);
    expect(dialog).toHaveTextContent('SMTP_PASSWORD');
    expect(dialog).toHaveTextContent('Current source: GUI override (****abcd)');
    const save = within(dialog).getByTestId('system-secrets-edit-save-btn');
    expect(save).toBeDisabled();

    const input = within(dialog).getByTestId('system-secrets-edit-value-input');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.click(within(dialog).getByTestId('system-secrets-edit-visibility-btn'));
    expect(input).toHaveAttribute('type', 'text');
    fireEvent.change(input, { target: { value: 'new-smtp-pass' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('/api/admin/system-secrets', {
        secretName: 'SMTP_PASSWORD',
        value: 'new-smtp-pass',
      })
    );
    await waitFor(() => expect(screen.queryByTestId('system-secrets-edit-dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('SMTP_PASSWORD saved successfully');
    await waitFor(() => expect(callsTo(SECRETS_URL)).toBe(2));
  });

  it('deletes an override only after the confirm dialog, with the same request', async () => {
    renderTab();
    await screen.findByTestId('system-secrets-row-SMTP_PASSWORD');

    openRowMenu('SMTP_PASSWORD');
    fireEvent.click(await screen.findByTestId('system-secrets-row-delete-SMTP_PASSWORD'));

    const dialog = await screen.findByTestId('system-secrets-delete-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveTextContent('SMTP_PASSWORD');
    expect(dialog).toHaveTextContent('The override value is not kept.');
    expect(mocks.delete).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByTestId('system-secrets-delete-confirm-btn'));

    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('/api/admin/system-secrets/db-1'));
    await waitFor(() => expect(screen.queryByTestId('system-secrets-delete-dialog')).toBeNull());
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Database override for SMTP_PASSWORD deleted');
  });

  it('keeps the header and shows skeleton rows while the lists load', async () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderTab();

    expect(await screen.findByTestId('admin-page-header')).toBeInTheDocument();
    for (const table of ['system-secrets-infra-table', 'system-secrets-table']) {
      expect(within(screen.getByTestId(table)).getAllByTestId('admin-table-skeleton-row').length).toBeGreaterThan(0);
    }
    expect(screen.queryByTestId('admin-empty-state')).toBeNull();
  });

  it('shows an error state with a retry when a list fails to load', async () => {
    respondWith({ [SECRETS_URL]: () => Promise.reject(new Error('boom')) });
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load the system secrets.');
    expect(await screen.findByTestId('system-secrets-infra-row-JWT_SECRET')).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();

    respondWith();
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('system-secrets-row-SMTP_PASSWORD')).toBeInTheDocument();
  });

  it('shows an error state with a retry when the infrastructure status fails to load', async () => {
    respondWith({ [TIER1_URL]: () => Promise.reject(new Error('boom')) });
    renderTab();

    const error = await screen.findByTestId('admin-error-state');
    expect(error).toHaveTextContent('Could not load the infrastructure secrets status.');
    expect(await screen.findByTestId('system-secrets-row-SMTP_PASSWORD')).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();

    respondWith();
    fireEvent.click(within(error).getByTestId('admin-error-retry-btn'));
    expect(await screen.findByTestId('system-secrets-infra-row-JWT_SECRET')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-error-state')).toBeNull();
  });

  it('shows an empty state when there are no infrastructure secrets to check', async () => {
    respondWith({ [TIER1_URL]: () => Promise.resolve({ data: { stage: 'preview-42', secrets: [] } }) });
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No infrastructure secrets to check');
    expect(await screen.findByTestId('system-secrets-row-SMTP_PASSWORD')).toBeInTheDocument();
    fireEvent.click(within(empty).getByTestId('system-secrets-infra-empty-refresh-btn'));
    await waitFor(() => expect(callsTo(TIER1_URL)).toBe(2));
    expect(callsTo(SECRETS_URL)).toBe(1);
  });

  it('shows an empty state when there are no configurable secrets', async () => {
    respondWith({ [SECRETS_URL]: () => Promise.resolve({ data: { secrets: [], tier1Note: '' } }) });
    renderTab();

    const empty = await screen.findByTestId('admin-empty-state');
    expect(empty).toHaveTextContent('No configurable secrets');
    fireEvent.click(within(empty).getByTestId('system-secrets-empty-refresh-btn'));
    await waitFor(() => expect(callsTo(SECRETS_URL)).toBe(2));
  });
});
