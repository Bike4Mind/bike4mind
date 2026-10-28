import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStatus, type AdminApiKeyAccess, type IUserApiKeyDocument } from '@bike4mind/common';
import { ProfileTestWrapper, buildProfile } from '../../profileTestUtils';
import { ApiKeysTab } from './ApiKeysTab';
import { SINGLE_REVOKE_REASON, UNDO_REVOKE_REASON } from './apiKeysModel';

const mocks = vi.hoisted(() => ({
  keys: vi.fn(),
  revoke: vi.fn(),
  restore: vi.fn(),
  rotate: vi.fn(),
  revokeAll: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({ useAdminGetUserApiKeys: mocks.keys }));
vi.mock('@client/app/hooks/data/adminUserCredits', () => {
  const mutation = (fn: (...args: unknown[]) => unknown) => () => ({ mutateAsync: fn, isPending: false });
  return {
    useAdminRevokeApiKey: mutation(mocks.revoke),
    useAdminRestoreApiKey: mutation(mocks.restore),
    useAdminRotateApiKey: mutation(mocks.rotate),
    useAdminRevokeAllApiKeys: mutation(mocks.revokeAll),
  };
});
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: mocks.toastSuccess } }));
vi.mock('../../../Details/AdminGenerateApiKeyModal', () => ({ default: () => null }));
vi.mock('../../../Details/AdminApiKeysModal', () => ({ default: () => null }));

const key = (overrides: Partial<IUserApiKeyDocument>): IUserApiKeyDocument =>
  ({
    id: 'key-1',
    name: 'ci-runner',
    keyPrefix: 'b4m_ab12',
    scopes: ['ai:*', 'files:read', 'notebooks:read'],
    status: ApiKeyStatus.ACTIVE,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastUsedAt: new Date('2026-10-26T00:00:00Z'),
    ...overrides,
  }) as IUserApiKeyDocument;

const KEYS = [
  key({}),
  key({ id: 'key-2', name: 'notebook-sync', keyPrefix: 'b4m_cd34', scopes: [] }),
  key({ id: 'key-3', name: 'old-laptop', keyPrefix: 'b4m_ef56', status: ApiKeyStatus.DISABLED, lastUsedAt: undefined }),
];

const PAID: AdminApiKeyAccess = { mode: 'paid', allowed: true, basis: 'paid_subscription' };

const respond = (overrides: Record<string, unknown> = {}) =>
  mocks.keys.mockReturnValue({
    data: {
      apiKeys: KEYS,
      liveUsage: {},
      requests: { 'key-1': { last24h: 120, last7d: 1204 }, 'key-2': { last24h: 0, last7d: 40 } },
      access: PAID,
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    ...overrides,
  });

const renderTab = () => render(<ApiKeysTab user={buildProfile()} />, { wrapper: ProfileTestWrapper });
const row = (id: string) => screen.getByTestId(`user-keys-row-${id}`);

describe('ApiKeysTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respond();
  });

  it('lists every key with prefix, scopes, request counts and status', () => {
    renderTab();

    const active = within(row('key-1'));
    expect(active.getByText('b4m_ab12')).toBeInTheDocument();
    expect(active.getByText('ai:*')).toBeInTheDocument();
    expect(active.getByText('+2')).toBeInTheDocument();
    expect(active.getByText('120 in 24h')).toBeInTheDocument();
    expect(active.getByText('1,204')).toBeInTheDocument();
    expect(active.getByTestId('admin-inline-bar')).toBeInTheDocument();
    expect(active.getByText('Active')).toBeInTheDocument();

    const revoked = within(row('key-3'));
    expect(revoked.getByText('Revoked')).toBeInTheDocument();
    expect(revoked.getByText('Never')).toBeInTheDocument();
    expect(revoked.queryByTestId('user-keys-revoke-btn')).not.toBeInTheDocument();
  });

  it('says in plain words whether the subscription gate lets the user use keys', () => {
    respond({
      data: {
        apiKeys: KEYS,
        liveUsage: {},
        requests: {},
        access: { mode: 'paid', allowed: false, basis: 'no_paid_subscription' },
      },
    });
    renderTab();

    expect(screen.getByTestId('user-keys-access-chip')).toHaveTextContent('Blocked');
    expect(screen.getByTestId('user-keys-access')).toHaveTextContent('need an active paid subscription');
  });

  it('shows the empty and error states', () => {
    respond({ data: { apiKeys: [], liveUsage: {}, requests: {}, access: PAID } });
    const { unmount } = renderTab();
    expect(screen.getByText('This user has no API keys.')).toBeInTheDocument();
    expect(screen.getByTestId('user-keys-revoke-all-btn')).toBeDisabled();
    unmount();

    respond({ data: undefined, isError: true });
    renderTab();
    expect(screen.getByText('API keys could not be loaded.')).toBeInTheDocument();
  });

  it('revokes a key at once with an audited reason, then restores it from Undo', async () => {
    mocks.revoke.mockResolvedValue(undefined);
    mocks.restore.mockResolvedValue(undefined);
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-revoke-btn'));

    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledWith({ keyId: 'key-1', reason: SINGLE_REVOKE_REASON }));
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent(
      'Revoked ci-runner. Requests using it now fail.'
    );

    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(mocks.restore).toHaveBeenCalledWith({ keyId: 'key-1', reason: UNDO_REVOKE_REASON }));
  });

  it('surfaces the server reason when Undo cannot restore the key', async () => {
    mocks.revoke.mockResolvedValue(undefined);
    mocks.restore.mockRejectedValue({ response: { data: { error: 'The restore window has passed.' } } });
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-revoke-btn'));
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    expect(await screen.findByTestId('undo-toast-error')).toHaveTextContent('The restore window has passed.');
  });

  it('reports a failed revoke and offers no Undo', async () => {
    mocks.revoke.mockRejectedValue(new Error('boom'));
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-revoke-btn'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('ci-runner could not be revoked. Try again.'));
    expect(screen.queryByTestId('undo-toast')).not.toBeInTheDocument();
  });

  it('rotates a key through an ActionDialog and shows the new secret once', async () => {
    mocks.rotate.mockResolvedValue({ keyId: 'key-9', keyPrefix: 'b4m_zz99', secret: 'b4m_zz99_secret_value' });
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-rotate-btn'));
    expect(screen.getByRole('dialog', { name: 'Rotate ci-runner' })).toBeInTheDocument();
    expect(screen.getByTestId('user-keys-rotate-dialog-confirm-btn')).toBeDisabled();

    fireEvent.click(screen.getByTestId('user-keys-rotate-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-keys-rotate-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.rotate).toHaveBeenCalledWith({ keyId: 'key-1', reason: 'Compromised or leaked key' })
    );
    const secret = await screen.findByTestId('user-keys-new-secret');
    expect(secret).toHaveTextContent('b4m_zz99_secret_value');
    expect(screen.queryByRole('dialog', { name: 'Rotate ci-runner' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('user-keys-secret-done-btn'));
    expect(screen.queryByTestId('user-keys-new-secret')).not.toBeInTheDocument();
  });

  it('keeps the rotate dialog open when the server refuses', async () => {
    mocks.rotate.mockRejectedValue({ response: { data: { error: 'API key is not active' } } });
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-rotate-btn'));
    fireEvent.click(screen.getByTestId('user-keys-rotate-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-keys-rotate-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('API key is not active'));
    expect(screen.getByRole('dialog', { name: 'Rotate ci-runner' })).toBeInTheDocument();
    expect(screen.queryByTestId('user-keys-new-secret')).not.toBeInTheDocument();
  });

  it('revokes every active key with a counted, reasoned confirm', async () => {
    mocks.revokeAll.mockResolvedValue({ revokedKeyIds: ['key-1', 'key-2'] });
    renderTab();

    fireEvent.click(screen.getByTestId('user-keys-revoke-all-btn'));
    expect(screen.getByRole('dialog', { name: 'Revoke all API keys' })).toHaveTextContent('Revokes 2 active keys');
    const confirm = screen.getByTestId('user-keys-revoke-all-dialog-confirm-btn');
    expect(confirm).toHaveTextContent('Revoke 2 keys');

    fireEvent.click(screen.getByTestId('user-keys-revoke-all-dialog-reason-input-preset-1'));
    fireEvent.click(confirm);

    await waitFor(() => expect(mocks.revokeAll).toHaveBeenCalledWith('Abuse / automated signups'));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Revoked 2 API keys.');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Revoke all API keys' })).not.toBeInTheDocument());
  });
});
