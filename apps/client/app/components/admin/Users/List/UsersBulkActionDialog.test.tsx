import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { AxiosError, AxiosHeaders } from 'axios';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import type {
  AdminUsersBulkPreview,
  AdminUsersBulkResult,
  AdminUsersBulkTarget,
  AdminUsersBulkUndoResult,
} from '@client/app/utils/adminUsersBulk';

const apiPost = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: apiPost } }));
vi.mock('sonner', () => ({ toast: toastMock }));

import { UndoToastProvider } from '../../shared/UndoToast';
import { UsersBulkActionDialog } from './UsersBulkActionDialog';

const theme = extendTheme({ ...getThemeConfig() });
const TARGET: AdminUsersBulkTarget = { kind: 'ids', userIds: ['a'.repeat(24), 'b'.repeat(24)] };

const preview = (overrides: Partial<AdminUsersBulkPreview> = {}): AdminUsersBulkPreview => ({
  matched: 3,
  eligible: 2,
  excluded: { self: 1, admins: 0 },
  alreadyApplied: 0,
  overCap: false,
  apiKeysToRevoke: 4,
  creditsDelta: 900,
  creditsOverCap: false,
  cohortHash: 'c'.repeat(64),
  emailDomains: null,
  sample: [{ id: 'a'.repeat(24), name: 'Ada', email: 'ada@example.test' }],
  ...overrides,
});

const executeResult = (overrides: Partial<AdminUsersBulkResult> = {}): AdminUsersBulkResult => ({
  batchId: 'batch-1',
  applied: 2,
  skipped: 0,
  failed: [],
  undoExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  partial: false,
  remaining: 0,
  blockedDomains: [],
  canceledSubscriptions: 0,
  subscriptionCancelFailures: [],
  ...overrides,
});

const undoResult = (overrides: Partial<AdminUsersBulkUndoResult> = {}): AdminUsersBulkUndoResult => ({
  restored: 2,
  failed: [],
  partial: false,
  remaining: 0,
  unblockedDomains: [],
  stillBlockedDomains: [],
  subscriptionsNotRestored: [],
  ...overrides,
});

const conflict = () =>
  new AxiosError('Conflict', '409', undefined, undefined, {
    status: 409,
    statusText: 'Conflict',
    data: { message: 'changed' },
    headers: {},
    config: { headers: new AxiosHeaders() },
  });

const renderDialog = (type: Parameters<typeof UsersBulkActionDialog>[0]['type']) => {
  const onClose = vi.fn();
  const onDone = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <CssVarsProvider theme={theme}>
        <UndoToastProvider>{children}</UndoToastProvider>
      </CssVarsProvider>
    </QueryClientProvider>
  );
  render(<UsersBulkActionDialog type={type} target={TARGET} onClose={onClose} onDone={onDone} />, {
    wrapper: Wrapper,
  });
  return { onClose, onDone };
};

const callsTo = (path: string) => apiPost.mock.calls.filter(([url]) => url === path);

beforeEach(() => {
  apiPost.mockReset();
  Object.values(toastMock).forEach(fn => fn.mockReset());
});

describe('UsersBulkActionDialog', () => {
  it('runs the Contain dry run, then commits the confirmed count with a reason and offers undo', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      if (url.endsWith('/execute')) return { data: executeResult() };
      return { data: undoResult() };
    });
    const { onClose, onDone } = renderDialog('contain');

    const dryRun = await screen.findByTestId('admin-users-bulk-dry-run');
    expect(dryRun).toHaveTextContent('2 users will change');
    expect(dryRun).toHaveTextContent('1 user excluded');
    expect(dryRun).toHaveTextContent('4 active API keys disabled');
    expect(dryRun).toHaveTextContent('900 credits removed');
    expect(callsTo('/api/admin/users/bulk/preview')[0][1]).toEqual({ target: TARGET, action: { type: 'contain' } });

    const confirm = screen.getByTestId('admin-users-bulk-contain-confirm-btn');
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-reason-input-preset-0'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    const [, body] = callsTo('/api/admin/users/bulk/execute')[0];
    expect(body).toMatchObject({
      target: TARGET,
      action: { type: 'contain' },
      reason: 'Spam or bot cohort',
      expectedCount: 2,
      cohortHash: 'c'.repeat(64),
    });
    expect(body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('Contained 2 users');
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));
    await waitFor(() => expect(callsTo('/api/admin/users/bulk/undo')[0][1]).toEqual({ batchId: 'batch-1' }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith('Restored 2 users'));
  });

  it('sends blockEmailDomains in the preview and the commit once the box is checked, and lists the domains', async () => {
    const emailDomains = { toBlock: ['acme.com'], alreadyBlocked: ['old.com'], notOwned: ['gmail.com'] };
    apiPost.mockImplementation(async (url: string, body: { action: { blockEmailDomains?: boolean } }) => {
      if (url.endsWith('/preview'))
        return { data: preview({ emailDomains: body.action.blockEmailDomains ? emailDomains : null }) };
      return { data: executeResult({ blockedDomains: ['acme.com'] }) };
    });
    const { onDone } = renderDialog('contain');
    await screen.findByTestId('admin-users-bulk-dry-run');
    expect(screen.getByTestId('admin-users-bulk-dry-run')).not.toHaveTextContent('email domain');

    fireEvent.click(screen.getByTestId('admin-users-bulk-block-domains-checkbox'));
    await waitFor(() => expect(callsTo('/api/admin/users/bulk/preview')).toHaveLength(2));
    expect(callsTo('/api/admin/users/bulk/preview')[1][1]).toEqual({
      target: TARGET,
      action: { type: 'contain', blockEmailDomains: true },
    });
    const dryRun = await screen.findByTestId('admin-users-bulk-dry-run');
    await waitFor(() => expect(dryRun).toHaveTextContent('1 email domain: acme.com'));
    expect(dryRun).toHaveTextContent('Already blocked: old.com.');
    expect(dryRun).toHaveTextContent('Skipped as public mail domains: gmail.com.');

    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-confirm-btn'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(callsTo('/api/admin/users/bulk/execute')[0][1]).toMatchObject({
      action: { type: 'contain', blockEmailDomains: true },
    });
  });

  it('warns when undo could not release a blocked domain', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      if (url.endsWith('/execute')) return { data: executeResult({ blockedDomains: ['acme.com'] }) };
      return { data: undoResult({ stillBlockedDomains: ['acme.com'] }) };
    });
    renderDialog('contain');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-confirm-btn'));
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() => expect(toastMock.warning).toHaveBeenCalledWith(expect.stringContaining('acme.com')));
  });

  it('reports canceled subscriptions, warns on cancel failures, and says undo cannot restore them', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      if (url.endsWith('/execute')) {
        return {
          data: executeResult({
            canceledSubscriptions: 2,
            subscriptionCancelFailures: [{ userId: 'u3', error: 'stripe down' }],
          }),
        };
      }
      return { data: undoResult({ subscriptionsNotRestored: ['sub_a', 'sub_b'] }) };
    });
    renderDialog('contain');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-contain-confirm-btn'));

    expect(screen.getByText(/live Stripe subscriptions are canceled with no refund and stay canceled/)).toBeTruthy();
    expect(await screen.findByTestId('undo-toast-message')).toHaveTextContent('canceled 2 Stripe subscription(s)');
    expect(toastMock.warning).toHaveBeenCalledWith(expect.stringContaining('Cancel them in Stripe'));
    fireEvent.click(screen.getByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        expect.stringContaining('2 canceled Stripe subscription(s) stay canceled')
      )
    );
  });

  it('defaults Adjust credits to "set to 0" and previews that', async () => {
    apiPost.mockResolvedValue({ data: preview() });
    renderDialog('adjustCredits');
    await screen.findByTestId('admin-users-bulk-dry-run');
    expect(callsTo('/api/admin/users/bulk/preview')[0][1]).toEqual({
      target: TARGET,
      action: { type: 'adjustCredits', mode: 'set', amount: 0 },
    });
  });

  it('refuses a cohort over the cap', async () => {
    apiPost.mockResolvedValue({ data: preview({ eligible: 900, overCap: true }) });
    renderDialog('suspend');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-reason-input-preset-0'));
    expect(screen.getByTestId('admin-users-bulk-suspend-confirm-btn')).toBeDisabled();
    expect(screen.getByText(/Narrow the filters to 500 or fewer/)).toBeTruthy();
  });

  it('refuses a batch over the total credit ceiling', async () => {
    apiPost.mockResolvedValue({ data: preview({ creditsOverCap: true }) });
    renderDialog('adjustCredits');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-adjustCredits-reason-input-preset-0'));
    expect(screen.getByTestId('admin-users-bulk-adjustCredits-confirm-btn')).toBeDisabled();
    expect(screen.getByText(/more than 1,000,000 credits in total/)).toBeTruthy();
  });

  it('warns when the run stopped before every user was changed', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      return { data: executeResult({ applied: 1, partial: true, remaining: 1 }) };
    });
    const { onDone } = renderDialog('suspend');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-confirm-btn'));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(toastMock.warning).toHaveBeenCalledWith(
      'Stopped after 1 user; 1 user not changed. Run it again for the rest.'
    );
  });

  const confirmSuspend = async () => {
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-suspend-confirm-btn'));
  };

  it('subtracts users that already match from the will-change count', async () => {
    apiPost.mockResolvedValue({ data: preview({ eligible: 10, alreadyApplied: 3 }) });
    renderDialog('suspend');
    expect(await screen.findByTestId('admin-users-bulk-dry-run')).toHaveTextContent(
      '7 users will change; 3 already match and are skipped'
    );
  });

  it('says nothing changed, with no undo toast, when no user was applied', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      return { data: executeResult({ applied: 0, skipped: 2 }) };
    });
    const { onDone } = renderDialog('suspend');
    await confirmSuspend();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(toastMock.info).toHaveBeenCalledWith('No users were changed.');
    expect(screen.queryByTestId('undo-toast-message')).toBeNull();
  });

  it('warns that undo is unavailable when the undo window already closed', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      return { data: executeResult({ undoExpiresAt: new Date(Date.now() - 1000).toISOString() }) };
    });
    const { onDone } = renderDialog('suspend');
    await confirmSuspend();

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(toastMock.success).toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalledWith('Undo is not available for this batch.');
    expect(screen.queryByTestId('undo-toast-message')).toBeNull();
  });

  it('warns when undo stopped at the time limit before restoring everyone', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      if (url.endsWith('/execute')) return { data: executeResult() };
      return { data: undoResult({ restored: 1, partial: true, remaining: 1 }) };
    });
    renderDialog('suspend');
    await confirmSuspend();
    fireEvent.click(await screen.findByTestId('undo-toast-undo-btn'));

    await waitFor(() =>
      expect(toastMock.warning).toHaveBeenCalledWith(
        '1 user not restored before the time limit. Check them on their profiles.'
      )
    );
  });

  it('shows the server error from the shared error envelope', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      throw new AxiosError('Bad Request', '400', undefined, undefined, {
        status: 400,
        statusText: 'Bad Request',
        data: { error: 'Reason is too long' },
        headers: {},
        config: { headers: new AxiosHeaders() },
      });
    });
    renderDialog('restrict');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-restrict-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-restrict-confirm-btn'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('Restrict failed: Reason is too long'));
  });

  it('keeps the dialog open and re-counts when the cohort changed before commit', async () => {
    apiPost.mockImplementation(async (url: string) => {
      if (url.endsWith('/preview')) return { data: preview() };
      throw conflict();
    });
    const { onClose } = renderDialog('restrict');
    await screen.findByTestId('admin-users-bulk-dry-run');
    fireEvent.click(screen.getByTestId('admin-users-bulk-restrict-reason-input-preset-0'));
    fireEvent.click(screen.getByTestId('admin-users-bulk-restrict-confirm-btn'));

    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith(expect.stringMatching(/changed/)));
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(callsTo('/api/admin/users/bulk/preview')).toHaveLength(2));
  });
});
