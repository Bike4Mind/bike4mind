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
} from '@client/app/utils/adminUsersBulk';

const apiPost = vi.hoisted(() => vi.fn());
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
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
  sample: [{ id: 'a'.repeat(24), name: 'Ada', email: 'ada@example.test' }],
  ...overrides,
});

const executeResult = (overrides: Partial<AdminUsersBulkResult> = {}): AdminUsersBulkResult => ({
  batchId: 'batch-1',
  applied: 2,
  skipped: 0,
  failed: [],
  undoExpiresAt: '',
  partial: false,
  remaining: 0,
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
      return { data: { restored: 2, failed: [] } };
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
