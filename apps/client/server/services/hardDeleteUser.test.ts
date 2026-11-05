import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findUser: vi.fn(),
  deleteUser: vi.fn(),
  readGrants: vi.fn(),
  readCustomers: vi.fn(),
  cancelSubscriptions: vi.fn(),
  purge: vi.fn(),
  order: [] as string[],
}));
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: h.findUser, delete: h.deleteUser },
  withTransaction: async (callback: () => Promise<unknown>) => callback(),
}));
vi.mock('@server/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: h.cancelSubscriptions,
  readAccountSubscriptionCustomerIds: h.readCustomers,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
  SINGLE_USER_CANCEL_BUDGET_MS: 30_000,
}));
vi.mock('@server/services/purgeDeletedUserData', () => ({
  readUserIntegrationGrants: h.readGrants,
  purgeDeletedUserData: h.purge,
}));
vi.mock('@server/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('@server/analytics/billingEventDetails', () => ({ wholeDaysBetween: vi.fn() }));
vi.mock('@server/analytics/resolveUserType', () => ({ resolveUserType: vi.fn() }));
vi.mock('@bike4mind/server-utils/analytics/pseudonymize', () => ({ pseudonymizeUserId: vi.fn() }));

import { hardDeleteUser, type HardDeleteContext } from './hardDeleteUser';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const context: HardDeleteContext = {
  deletedBy: 'user-1',
  initiatedBy: 'self',
  logger,
};
const runDelete = (overrides: Partial<HardDeleteContext> = {}) =>
  hardDeleteUser('user-1', { ...context, ...overrides }, users => users.delete('user-1'));

beforeEach(() => {
  vi.resetAllMocks();
  h.order.length = 0;
  h.findUser.mockResolvedValue(null);
  h.readGrants.mockResolvedValue(null);
  h.readCustomers.mockResolvedValue(['cus_captured']);
  h.deleteUser.mockImplementation(async () => {
    h.order.push('delete');
  });
  h.cancelSubscriptions.mockImplementation(async () => {
    h.order.push('cancel');
    return { canceled: ['sub_1'], failed: [] };
  });
  h.purge.mockImplementation(async () => {
    h.order.push('purge');
  });
});

describe('hardDeleteUser guarded self-serve purge', () => {
  it('does not cancel restored subscriptions when the due-date assertion aborts deletion', async () => {
    await expect(
      runDelete({
        assertInTransaction: async () => {
          throw new Error('deletion cancelled');
        },
      })
    ).rejects.toThrow('deletion cancelled');

    expect(h.readCustomers).toHaveBeenCalledWith('user-1');
    expect(h.deleteUser).not.toHaveBeenCalled();
    expect(h.cancelSubscriptions).not.toHaveBeenCalled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('cancels using captured customers only after the guarded delete commits', async () => {
    await expect(runDelete()).resolves.toMatchObject({ subscriptionCancellation: { canceled: ['sub_1'], failed: [] } });

    expect(h.order).toEqual(['delete', 'cancel', 'purge']);
    expect(h.cancelSubscriptions).toHaveBeenCalledWith(
      { userId: 'user-1', reason: 'account_deleted', customerIds: ['cus_captured'], deadline: expect.any(Number) },
      logger
    );
  });

  it('does not cancel when the database delete fails', async () => {
    h.deleteUser.mockRejectedValue(new Error('delete failed'));

    await expect(runDelete()).rejects.toThrow('delete failed');
    expect(h.cancelSubscriptions).not.toHaveBeenCalled();
    expect(h.purge).not.toHaveBeenCalled();
  });

  it('still purges a committed delete if cancellation unexpectedly throws', async () => {
    h.cancelSubscriptions.mockRejectedValue(new Error('unexpected cancellation error'));

    await expect(runDelete()).rejects.toThrow('unexpected cancellation error');
    expect(h.purge).toHaveBeenCalledWith('user-1', { deletedBy: 'user-1', logger, integrationGrants: null });
  });

  it('keeps admin cancellation before deletion by default', async () => {
    await runDelete({ initiatedBy: 'admin' });

    expect(h.order).toEqual(['cancel', 'delete', 'purge']);
    expect(h.readCustomers).not.toHaveBeenCalled();
    expect(h.cancelSubscriptions).toHaveBeenCalledWith(
      { userId: 'user-1', reason: 'account_deleted', deadline: expect.any(Number) },
      logger
    );
  });
});
