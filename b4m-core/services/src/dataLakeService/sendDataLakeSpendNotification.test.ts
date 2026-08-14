import { describe, expect, it, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ resolveLakeSpendAddressees: vi.fn() }));
vi.mock('./resolveLakeSpendAddressees', async importOriginal => ({
  ...(await importOriginal<typeof import('./resolveLakeSpendAddressees')>()),
  resolveLakeSpendAddressees: h.resolveLakeSpendAddressees,
}));

import { sendDataLakeSpendNotification } from './sendDataLakeSpendNotification';

const logger = { warn: vi.fn(), log: vi.fn(), error: vi.fn(), info: vi.fn() } as never;

const baseEvent = {
  dataLakeId: 'lake-1',
  kind: 'budget_exhausted' as const,
  scope: 'lake' as const,
  periodKey: 'lake:100000000',
  detail: { spentMicroUsd: 5_000_000, budgetMicroUsd: 5_000_000 },
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  const claimNotification = vi.fn().mockResolvedValue({ claimed: true, id: 'notif-1' });
  const markDelivered = vi.fn().mockResolvedValue(undefined);
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const db = {
    dataLakes: { findById: vi.fn().mockResolvedValue({ id: 'lake-1', name: 'My Lake', organizationId: null }) },
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    users: { findActiveEmailsByIds: vi.fn().mockResolvedValue([]) },
    spendNotifications: { claimNotification, markDelivered },
  };
  return { db, mailer: { sendEmail }, logger, claimNotification, markDelivered, sendEmail, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveLakeSpendAddressees.mockResolvedValue([{ userId: 'u1', email: 'owner@example.com' }]);
});

describe('sendDataLakeSpendNotification', () => {
  it('claims, sends one email per recipient, and marks delivered', async () => {
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com' },
      { userId: 'u2', email: 'b@example.com' },
    ]);

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('sent');
    expect(deps.sendEmail).toHaveBeenCalledTimes(2);
    // One message PER recipient - never a joined `to:` list.
    expect(deps.sendEmail).toHaveBeenCalledWith('a@example.com', expect.anything());
    expect(deps.sendEmail).toHaveBeenCalledWith('b@example.com', expect.anything());
    expect(deps.markDelivered).toHaveBeenCalledWith('notif-1', {
      recipientUserIds: ['u1', 'u2'],
      deliveredCount: 2,
      deliveryFailed: false,
    });
  });

  it('short-circuits on a dedupe - addressee resolution never runs, no email sent', async () => {
    const deps = makeDeps();
    deps.claimNotification.mockResolvedValue({ claimed: false });

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('deduped');
    expect(h.resolveLakeSpendAddressees).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  it('marks delivered with zero recipients and keeps the claim when there are no addressees', async () => {
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockResolvedValue([]);

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('no-addressees');
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.markDelivered).toHaveBeenCalledWith('notif-1', {
      recipientUserIds: [],
      deliveredCount: 0,
      deliveryFailed: false,
    });
  });

  it('counts a mailer false-return as undelivered and reports failed when nothing delivered', async () => {
    const deps = makeDeps();
    deps.sendEmail.mockResolvedValue(false);

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('failed');
    expect(deps.markDelivered).toHaveBeenCalledWith('notif-1', {
      recipientUserIds: ['u1'],
      deliveredCount: 0,
      deliveryFailed: true,
    });
  });

  it("one recipient's sendEmail throwing does not skip another's", async () => {
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockResolvedValue([
      { userId: 'u1', email: 'a@example.com' },
      { userId: 'u2', email: 'b@example.com' },
    ]);
    deps.sendEmail.mockRejectedValueOnce(new Error('smtp down')).mockResolvedValueOnce(undefined);

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('sent');
    expect(deps.markDelivered).toHaveBeenCalledWith('notif-1', {
      recipientUserIds: ['u1', 'u2'],
      deliveredCount: 1,
      deliveryFailed: false,
    });
  });

  it('never throws - a claim repo failure resolves to failed and is logged', async () => {
    const deps = makeDeps();
    deps.claimNotification.mockRejectedValue(new Error('mongo down'));

    await expect(sendDataLakeSpendNotification(baseEvent, deps)).resolves.toBe('failed');
  });
});
