import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';
import type { AdminUsersBulkResult } from '@client/app/utils/adminUsersBulk';

const { showUndo, undo } = vi.hoisted(() => ({ showUndo: vi.fn(), undo: vi.fn() }));
vi.mock('../../shared/UndoToast', () => ({ useUndoToast: () => showUndo }));
vi.mock('./useAdminUsersBulk', () => ({ useAdminUsersBulkUndo: () => ({ mutateAsync: undo }) }));
vi.mock('sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn(), info: vi.fn() } }));

import { useUsersBulkResult } from './useUsersBulkResult';

const resultOf = (overrides: Partial<AdminUsersBulkResult> = {}): AdminUsersBulkResult => ({
  batchId: 'batch',
  applied: 1,
  skipped: 0,
  failed: [],
  partial: false,
  remaining: 0,
  undoExpiresAt: new Date(Date.now() + 30_000).toISOString(),
  blockedDomains: [],
  canceledSubscriptions: 0,
  subscriptionCancelFailures: [],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bulk outcome feedback', () => {
  it('warns about partial changes, failed users and manual subscription cancellation, while offering undo', async () => {
    const { result } = renderHook(() => useUsersBulkResult());
    result.current(
      resultOf({
        partial: true,
        remaining: 2,
        failed: [{ userId: 'a', error: 'failed' }],
        subscriptionCancelFailures: [{ userId: 'b', error: 'cancel failed' }],
      })
    );
    expect(toast.warning).toHaveBeenCalledWith('1 users could not be changed.');
    expect(toast.warning).toHaveBeenCalledWith('Stopped after 1 user; 2 users not changed. Run it again for the rest.');
    expect(toast.warning).toHaveBeenCalledWith(
      'Could not cancel the Stripe subscriptions of 1 user. Cancel them in Stripe.'
    );
    const options = showUndo.mock.calls[0]![0] as { onUndo: () => Promise<void> };
    undo.mockResolvedValue({
      stillBlockedDomains: [],
      subscriptionsNotRestored: ['sub'],
      partial: false,
      failed: [],
      restored: 1,
    });
    await options.onUndo();
    expect(undo).toHaveBeenCalledWith('batch');
    expect(toast.warning).toHaveBeenCalledWith(
      '1 canceled Stripe subscription(s) stay canceled; the users must subscribe again.'
    );
  });

  it('does not offer undo after its deadline', () => {
    const { result } = renderHook(() => useUsersBulkResult());
    result.current(resultOf({ undoExpiresAt: new Date(Date.now() - 1).toISOString() }));
    expect(showUndo).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledWith('Undo is not available for this batch.');
  });
  it('keeps cancellation failure warnings when no user update completed', () => {
    const { result } = renderHook(() => useUsersBulkResult());
    result.current(resultOf({ applied: 0, subscriptionCancelFailures: [{ userId: 'a', error: 'cancel failed' }] }));
    expect(toast.warning).toHaveBeenCalledWith(
      'Could not cancel the Stripe subscriptions of 1 user. Cancel them in Stripe.'
    );
    expect(toast.info).toHaveBeenCalledWith('No users were changed.');
  });
});
