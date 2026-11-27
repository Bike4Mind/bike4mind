import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiKeyStatus,
  MODERATION_EXCEPTION_CATEGORIES,
  type AdminApiKeyAccess,
  type IUserApiKeyDocument,
} from '@bike4mind/common';
import { useUser } from '@client/app/contexts/UserContext';
import { ProfileTestWrapper, buildProfile } from '../../profileTestUtils';
import { ApiKeysTab } from './ApiKeysTab';
import { SINGLE_REVOKE_REASON, UNDO_REVOKE_REASON } from './apiKeysModel';

const mocks = vi.hoisted(() => ({
  keys: vi.fn(),
  revoke: vi.fn(),
  restore: vi.fn(),
  rotate: vi.fn(),
  setModeration: vi.fn(),
  revokeAll: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('@client/app/hooks/data/userApiKeys', () => ({ useAdminGetUserApiKeys: mocks.keys }));
vi.mock('@client/app/hooks/data/adminUserTimeline', () => ({
  useUserTimeline: () => ({
    data: { pages: [{ entries: [], nextCursor: null }] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    hasNextPage: false,
  }),
}));
vi.mock('@client/app/hooks/data/adminUserCredits', () => {
  const mutation = (fn: (...args: unknown[]) => unknown) => () => ({ mutateAsync: fn, isPending: false });
  return {
    useAdminRevokeApiKey: mutation(mocks.revoke),
    useAdminRestoreApiKey: mutation(mocks.restore),
    useAdminRotateApiKey: mutation(mocks.rotate),
    useAdminSetApiKeyModerationException: mutation(mocks.setModeration),
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
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
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
  it('resets request filters when switching to another cached user', () => {
    respond();
    const view = renderTab();
    fireEvent.click(screen.getByTestId('user-api-requests-from-set-btn'));
    fireEvent.change(screen.getByLabelText('Requests from UTC date'), { target: { value: '2026-11-01' } });
    expect(screen.getByLabelText('Requests from UTC date')).toHaveValue('2026-11-01');
    view.rerender(<ApiKeysTab user={buildProfile({ id: 'another-user' })} />);
    expect(screen.queryByLabelText('Requests from UTC date')).not.toBeInTheDocument();
    expect(screen.getByTestId('user-api-requests-from-empty')).toBeInTheDocument();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    useUser.setState({ currentUser: { id: 'admin1', isAdmin: true } as never });
    respond();
  });

  afterEach(() => vi.restoreAllMocks());

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

  it.each([
    { minute: 60, day: 999, limit: 'Per-minute', reset: '30s' },
    { minute: 59, day: 1000, limit: 'Per-day', reset: '1h 0m' },
  ])('shows live $limit exhaustion and its reset time', async ({ minute, day, limit, reset }) => {
    const now = Math.floor(Date.now() / 1000);
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
    respond({
      data: {
        apiKeys: [key({})],
        liveUsage: { 'key-1': { minute, day, minuteResetAt: now + 30, dayResetAt: now + 3600 } },
        requests: {},
        access: PAID,
      },
    });
    renderTab();

    expect(within(row('key-1')).getByText('At limit')).toBeInTheDocument();
    expect(within(row('key-1')).queryByText('Active')).not.toBeInTheDocument();
    fireEvent.mouseOver(screen.getByTestId('user-keys-live-limit'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(`${limit} limit reached`);
    expect(screen.getByRole('tooltip')).toHaveTextContent(`resets in ${reset}`);
  });

  it('keeps under-limit keys active and preserves revoked status even at the ceiling', () => {
    respond({
      data: {
        apiKeys: [key({}), key({ id: 'revoked', status: ApiKeyStatus.DISABLED })],
        liveUsage: { 'key-1': { minute: 59, day: 999 }, revoked: { minute: 60, day: 1000 } },
        requests: {},
        access: PAID,
      },
    });
    renderTab();

    expect(within(row('key-1')).getByText('Active')).toBeInTheDocument();
    expect(within(row('revoked')).getByText('Revoked')).toBeInTheDocument();
    expect(screen.queryByTestId('user-keys-live-limit')).not.toBeInTheDocument();
  });

  it('does not present expired counter windows as live limits', () => {
    const resetAt = Math.floor(Date.now() / 1000) - 1;
    respond({
      data: {
        apiKeys: [key({})],
        liveUsage: { 'key-1': { minute: 60, day: 1000, minuteResetAt: resetAt, dayResetAt: resetAt } },
        requests: {},
        access: PAID,
      },
    });
    renderTab();
    expect(within(row('key-1')).getByText('Active')).toBeInTheDocument();
  });

  it('describes both exhausted windows and refreshes the status when counters clear', async () => {
    respond({
      data: {
        apiKeys: [key({})],
        liveUsage: { 'key-1': { minute: 61, day: 1001 } },
        requests: {},
        access: PAID,
      },
    });
    const view = renderTab();
    fireEvent.mouseOver(screen.getByTestId('user-keys-live-limit'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Per-minute limit reached (61/60); reset time unavailable.');
    expect(tooltip).toHaveTextContent('Per-day limit reached (1001/1000); reset time unavailable.');

    respond({
      data: { apiKeys: [key({})], liveUsage: { 'key-1': { minute: 0, day: 0 } }, requests: {}, access: PAID },
    });
    view.rerender(<ApiKeysTab user={buildProfile()} />);
    expect(within(row('key-1')).getByText('Active')).toBeInTheDocument();
    expect(mocks.keys).toHaveBeenLastCalledWith(expect.any(String), { refetchInterval: 15_000 });
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

  it('shows which keys carry a moderation exception', () => {
    respond({
      data: {
        apiKeys: KEYS,
        liveUsage: {},
        requests: {},
        access: PAID,
        moderationExceptions: {
          'key-2': { categories: ['violence'], reason: 'Security research', setAt: '2026-11-01T00:00:00.000Z' },
        },
      },
    });
    renderTab();

    expect(within(row('key-1')).getByTestId('user-keys-moderation-chip')).toHaveTextContent('Standard');
    expect(within(row('key-2')).getByTestId('user-keys-moderation-chip')).toHaveTextContent('Exception');
  });

  const category = (name: string) => screen.getByTestId(`user-keys-moderation-category-${name}`);

  it('offers exactly the accepted categories and requires at least one before saving', () => {
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
    expect(screen.getByRole('dialog', { name: 'Moderation exception' })).toBeInTheDocument();
    for (const name of MODERATION_EXCEPTION_CATEGORIES) expect(category(name)).not.toBeChecked();
    expect(screen.getByTestId('user-keys-moderation-categories').querySelectorAll('input')).toHaveLength(
      MODERATION_EXCEPTION_CATEGORIES.length
    );

    fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-0'));
    expect(screen.getByTestId('user-keys-moderation-dialog-confirm-btn')).toBeDisabled();
    expect(screen.queryByTestId('user-keys-moderation-dialog-secondary-btn')).not.toBeInTheDocument();
  });

  it('saves the chosen categories with an audited reason', async () => {
    mocks.setModeration.mockResolvedValue(undefined);
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
    fireEvent.click(category('violence'));
    fireEvent.click(category('VIOLENCE'));
    fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-confirm-btn'));

    await waitFor(() =>
      expect(mocks.setModeration).toHaveBeenCalledWith({
        keyId: 'key-1',
        reason: 'Approved security research',
        categories: ['violence', 'VIOLENCE'],
      })
    );
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Moderation exception' })).not.toBeInTheDocument());
  });

  describe('with an existing exception', () => {
    beforeEach(() => {
      mocks.setModeration.mockResolvedValue(undefined);
      respond({
        data: {
          apiKeys: KEYS,
          liveUsage: {},
          requests: {},
          access: PAID,
          moderationExceptions: {
            'key-1': {
              categories: ['violence/graphic'],
              reason: 'Security research',
              setAt: '2026-11-01T00:00:00.000Z',
            },
          },
        },
      });
    });

    it('preselects the current categories and saves a changed set', async () => {
      renderTab();

      fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
      expect(category('violence/graphic')).toBeChecked();
      expect(category('violence')).not.toBeChecked();

      fireEvent.click(category('violence'));
      fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-1'));
      fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-confirm-btn'));

      await waitFor(() =>
        expect(mocks.setModeration).toHaveBeenCalledWith({
          keyId: 'key-1',
          reason: 'Violence-related content is core to the product',
          categories: ['violence', 'violence/graphic'],
        })
      );
    });

    it('clears the exception with a separate action that sends no categories', async () => {
      renderTab();

      fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
      fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-2'));
      fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-secondary-btn'));

      await waitFor(() =>
        expect(mocks.setModeration).toHaveBeenCalledWith({
          keyId: 'key-1',
          reason: 'Exception no longer needed',
          categories: [],
        })
      );
    });
  });

  describe('with an existing exception and every category unchecked', () => {
    beforeEach(() => {
      mocks.setModeration.mockResolvedValue(undefined);
      respond({
        data: {
          apiKeys: KEYS,
          liveUsage: {},
          requests: {},
          access: PAID,
          moderationExceptions: {
            'key-1': {
              categories: ['violence/graphic'],
              reason: 'Security research',
              setAt: '2026-11-01T00:00:00.000Z',
            },
          },
        },
      });
    });

    it('blocks saving but still allows removing the exception', async () => {
      renderTab();

      fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
      fireEvent.click(category('violence/graphic'));
      fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-2'));

      expect(screen.getByTestId('user-keys-moderation-dialog-confirm-btn')).toBeDisabled();
      expect(screen.getByTestId('user-keys-moderation-dialog-hint')).toHaveTextContent('Choose at least one category.');
      const remove = screen.getByTestId('user-keys-moderation-dialog-secondary-btn');
      expect(remove).toBeEnabled();

      fireEvent.click(remove);
      await waitFor(() =>
        expect(mocks.setModeration).toHaveBeenCalledWith({
          keyId: 'key-1',
          reason: 'Exception no longer needed',
          categories: [],
        })
      );
    });
  });

  it('keeps the moderation dialog open and reports a server refusal', async () => {
    mocks.setModeration.mockRejectedValue({ response: { data: { error: 'API key not found' } } });
    renderTab();

    fireEvent.click(within(row('key-1')).getByTestId('user-keys-moderation-btn'));
    fireEvent.click(category('violence'));
    fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('user-keys-moderation-dialog-confirm-btn'));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('API key not found'));
    expect(screen.getByRole('dialog', { name: 'Moderation exception' })).toBeInTheDocument();
  });

  it('disables the moderation action without users:moderate, naming the permission', () => {
    useUser.setState({ currentUser: { id: 'd1', isAdmin: false, adminPermissions: ['keys:revoke'] } as never });
    renderTab();
    const button = within(row('key-1')).getByTestId('user-keys-moderation-btn');
    expect(button).toBeDisabled();
    expect((button.parentElement as HTMLElement).getAttribute('aria-label')).toBe('Missing permission: users:moderate');
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

describe('ApiKeysTab permission gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    respond();
  });
  afterEach(() => vi.restoreAllMocks());

  const actAs = (adminPermissions: string[]) =>
    useUser.setState({ currentUser: { id: 'd1', isAdmin: false, adminPermissions } as never });

  // Joy's Tooltip puts the title on its child as aria-label; the row buttons sit inside that span.
  const reasonOf = (el: HTMLElement) => (el.parentElement as HTMLElement).getAttribute('aria-label');
  const rowRevoke = () => within(row('key-1')).getByTestId('user-keys-revoke-btn');
  const rowRotate = () => within(row('key-1')).getByTestId('user-keys-rotate-btn');
  const reason = (id: string) => screen.getByTestId(id).getAttribute('aria-label');
  const ADMIN_TARGET = 'Only full administrators can act on accounts with admin access';

  it('disables every key action for a delegate without keys:revoke, naming the permission', () => {
    actAs(['support:read']);
    renderTab();
    const missing = 'Missing permission: keys:revoke';
    expect(rowRevoke()).toBeDisabled();
    expect(reasonOf(rowRevoke())).toBe(missing);
    expect(rowRotate()).toBeDisabled();
    expect(reasonOf(rowRotate())).toBe(missing);
    expect(screen.getByTestId('user-keys-revoke-all-btn')).toBeDisabled();
    expect(reason('user-keys-revoke-all-reason')).toBe(missing);
    expect(screen.getByTestId('user-profile-generate-key-btn')).toBeDisabled();
    expect(reason('user-profile-generate-key-reason')).toBe(missing);
  });

  it('lets keys:revoke alone revoke but not rotate or generate, which hand back a secret', () => {
    actAs(['keys:revoke']);
    renderTab();
    expect(rowRevoke()).toBeEnabled();
    expect(screen.getByTestId('user-keys-revoke-all-btn')).toBeEnabled();
    expect(rowRotate()).toBeDisabled();
    expect(reasonOf(rowRotate())).toBe('Missing permission: users:impersonate');
    expect(reason('user-profile-generate-key-reason')).toBe('Missing permission: users:impersonate');
  });

  it('enables everything for a delegate holding both permissions', () => {
    actAs(['keys:revoke', 'users:impersonate']);
    renderTab();
    expect(rowRotate()).toBeEnabled();
    expect(screen.getByTestId('user-profile-generate-key-btn')).toBeEnabled();
  });

  it('disables every action, with the reason, for a delegate on an account with admin access', () => {
    actAs(['keys:revoke', 'users:impersonate']);
    render(<ApiKeysTab user={buildProfile({ adminPermissions: ['support:read'] } as never)} />, {
      wrapper: ProfileTestWrapper,
    });
    expect(rowRevoke()).toBeDisabled();
    expect(reasonOf(rowRevoke())).toBe(ADMIN_TARGET);
    expect(rowRotate()).toBeDisabled();
    expect(reasonOf(rowRotate())).toBe(ADMIN_TARGET);
    expect(screen.getByTestId('user-keys-revoke-all-btn')).toBeDisabled();
    expect(reason('user-keys-revoke-all-reason')).toBe(ADMIN_TARGET);
    expect(screen.getByTestId('user-profile-generate-key-btn')).toBeDisabled();
    expect(reason('user-profile-generate-key-reason')).toBe(ADMIN_TARGET);
  });
});
