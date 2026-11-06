import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import { PendingBulkDialog } from './PendingBulkDialog';
import { bulkOutcome } from './usePendingBulkActions';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  showUndoToast: vi.fn(),
  toast: { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post: mocks.post } }));
vi.mock('../../shared/UndoToast', () => ({ useUndoToast: () => mocks.showUndoToast }));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const theme = extendTheme({ ...getThemeConfig() });

let queryClient: QueryClient;
const Wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>
    <CssVarsProvider theme={theme}>{children}</CssVarsProvider>
  </QueryClientProvider>
);

type Responses = Record<string, (body: Record<string, unknown>) => unknown>;
const routeTo = (responses: Responses) =>
  mocks.post.mockImplementation(async (path: string, body: Record<string, unknown>) => ({
    data: responses[path](body),
  }));

const preview = (rows: { userId: string; outcome: string; reason?: string }[]) => ({
  dryRun: true,
  results: rows,
  undoUserIds: [],
});

const renderDialog = (kind: 'release' | 'block', onDone = vi.fn()) =>
  render(<PendingBulkDialog kind={kind} userIds={[A, B]} onClose={vi.fn()} onDone={onDone} />, { wrapper: Wrapper });

const confirmWithReason = async (kind: 'release' | 'block') => {
  const confirm = await screen.findByTestId(`pending-bulk-${kind}-confirm-btn`);
  await waitFor(() => expect(screen.getByTestId('pending-bulk-would-apply')).toBeInTheDocument());
  fireEvent.click(screen.getByTestId(`pending-bulk-${kind}-reason-input-preset-0`));
  await waitFor(() => expect(confirm).not.toBeDisabled());
  fireEvent.click(confirm);
};

describe('PendingBulkDialog', () => {
  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.post.mockReset();
    mocks.showUndoToast.mockReset();
    Object.values(mocks.toast).forEach(fn => fn.mockReset());
  });

  it('shows the dry-run count and noop reasons before anything runs', async () => {
    routeTo({
      '/api/admin/signup-grants/bulk-block': () =>
        preview([
          { userId: A, outcome: 'would_apply' },
          { userId: B, outcome: 'noop', reason: 'already_blocked' },
        ]),
    });
    renderDialog('block');
    expect(await screen.findByTestId('pending-bulk-would-apply')).toHaveTextContent('1 account of 2 selected');
    expect(screen.getByTestId('pending-bulk-noop-already_blocked')).toHaveTextContent(
      'This account is already blocked.'
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith('/api/admin/signup-grants/bulk-block', { userIds: [A, B], dryRun: true });
  });

  it('keeps confirm disabled when the dry run finds nothing to change', async () => {
    routeTo({
      '/api/admin/held-signup-grants/release': () =>
        preview([
          { userId: A, outcome: 'noop', reason: 'not_held' },
          { userId: B, outcome: 'noop', reason: 'not_held' },
        ]),
    });
    renderDialog('release');
    await screen.findByTestId('pending-bulk-would-apply');
    fireEvent.click(screen.getByTestId('pending-bulk-release-reason-input-preset-0'));
    expect(screen.getByTestId('pending-bulk-release-confirm-btn')).toBeDisabled();
    expect(screen.getByTestId('pending-bulk-release-hint')).toHaveTextContent('None of the selected accounts');
  });

  it('runs a block, then its undo unblocks exactly undoUserIds', async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, 'invalidateQueries');
    routeTo({
      '/api/admin/signup-grants/bulk-block': body =>
        body.dryRun
          ? preview([
              { userId: A, outcome: 'would_apply' },
              { userId: B, outcome: 'would_apply' },
            ])
          : {
              dryRun: false,
              results: [
                { userId: A, outcome: 'applied' },
                { userId: B, outcome: 'failed' },
              ],
              undoUserIds: [A],
            },
      '/api/admin/signup-grants/bulk-unblock': () => ({
        dryRun: false,
        results: [{ userId: A, outcome: 'applied' }],
        undoUserIds: [A],
      }),
    });
    const onDone = vi.fn();
    renderDialog('block', onDone);
    await confirmWithReason('block');

    await waitFor(() => expect(mocks.showUndoToast).toHaveBeenCalledTimes(1));
    const realCall = mocks.post.mock.calls.find(([, body]) => !body.dryRun)!;
    expect(realCall[1]).toMatchObject({ userIds: [A, B], reason: expect.any(String) });
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ failedIds: [B], applied: 1 }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'signup-grants'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['admin', 'users', A] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users', A] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['held-signup-grants'] });

    await mocks.showUndoToast.mock.calls[0][0].onUndo();
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/signup-grants/bulk-unblock', {
      userIds: [A],
      reason: expect.stringMatching(/^Undo: /),
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Restored 1 account');
    invalidate.mockRestore();
  });

  it('runs a release, then its undo revokes the batch', async () => {
    routeTo({
      '/api/admin/held-signup-grants/release': body =>
        body.dryRun
          ? preview([{ userId: A, outcome: 'would_apply' }])
          : {
              batchId: 'c'.repeat(24),
              results: [
                { userId: A, outcome: 'released', credits: 500 },
                { userId: B, outcome: 'not_held', credits: 0 },
              ],
            },
      '/api/admin/held-signup-grants/revoke': () => ({
        batchId: 'c'.repeat(24),
        results: [{ userId: A, outcome: 'insufficient_balance' }],
      }),
    });
    renderDialog('release');
    await confirmWithReason('release');

    await waitFor(() => expect(mocks.showUndoToast).toHaveBeenCalledTimes(1));
    const realCall = mocks.post.mock.calls.find(([, body]) => !body.dryRun)!;
    expect(realCall[1]).toEqual({ userIds: [A, B] });

    await mocks.showUndoToast.mock.calls[0][0].onUndo();
    expect(mocks.post).toHaveBeenLastCalledWith('/api/admin/held-signup-grants/revoke', { batchId: 'c'.repeat(24) });
    expect(mocks.toast.warning).toHaveBeenCalledWith(expect.stringContaining('already spent the credits'));
  });

  it('offers no undo when the run changed nothing', async () => {
    routeTo({
      '/api/admin/signup-grants/bulk-block': body =>
        body.dryRun
          ? preview([{ userId: A, outcome: 'would_apply' }])
          : { dryRun: false, results: [{ userId: A, outcome: 'noop', reason: 'already_blocked' }], undoUserIds: [] },
    });
    renderDialog('block');
    await confirmWithReason('block');
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledWith('No accounts were changed.'));
    expect(mocks.showUndoToast).not.toHaveBeenCalled();
  });
});

describe('bulkOutcome', () => {
  it('keeps the two undo kinds apart', () => {
    expect(
      bulkOutcome('release', { batchId: 'x', results: [{ userId: A, outcome: 'released', credits: 1 }] }).undo
    ).toEqual({ kind: 'release', batchId: 'x' });
    expect(
      bulkOutcome('block', { dryRun: false, results: [{ userId: A, outcome: 'applied' }], undoUserIds: [A] }).undo
    ).toEqual({ kind: 'block', userIds: [A] });
  });

  it('has no undo for a release that paid nobody', () => {
    expect(
      bulkOutcome('release', { batchId: 'x', results: [{ userId: A, outcome: 'withheld', credits: 0 }] }).undo
    ).toBeNull();
  });
});
