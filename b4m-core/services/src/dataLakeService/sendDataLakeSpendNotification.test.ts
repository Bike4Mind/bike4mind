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
  const deleteNotification = vi.fn().mockResolvedValue(undefined);
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const db = {
    dataLakes: { findById: vi.fn().mockResolvedValue({ id: 'lake-1', name: 'My Lake', organizationId: null }) },
    dataLakeAccessGrants: { listByLake: vi.fn().mockResolvedValue([]) },
    organizations: { findById: vi.fn().mockResolvedValue(null) },
    users: { findActiveEmailsByIds: vi.fn().mockResolvedValue([]) },
    spendNotifications: { claimNotification, markDelivered, delete: deleteNotification },
  };
  return {
    db,
    mailer: { sendEmail },
    logger,
    claimNotification,
    markDelivered,
    deleteNotification,
    sendEmail,
    ...overrides,
  };
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

  it('DELETES the claim (does not keep it) when addressee resolution FAILS - null must not be treated like []', async () => {
    // A transient DB blip on the grant/org/user reads returns null (not []) from
    // resolveLakeSpendAddressees. Treating that like a genuinely-ownerless lake would keep the
    // claim and permanently silence this lake for the life of the period - the whole point of
    // distinguishing the two.
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockResolvedValue(null);

    const outcome = await sendDataLakeSpendNotification(baseEvent, deps);

    expect(outcome).toBe('failed');
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.markDelivered).not.toHaveBeenCalled();
    expect(deps.deleteNotification).toHaveBeenCalledWith('notif-1');
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

  it('resolves to failed (not hung) and DELETES the claim when the timeout fires BEFORE anything was dispatched (S2)', async () => {
    // markDelivered(deliveryFailed:true) would NOT re-arm - claimNotification's upsert keys
    // purely on (dataLakeId, kind, scope, periodKey) and never reads deliveryFailed. Only
    // deleting the row frees that unique-index slot for a future genuine attempt. Addressee
    // resolution hanging (not sendEmail) is what puts the timeout BEFORE dispatch starts.
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockImplementation(() => new Promise(() => {})); // hangs pre-dispatch

    const outcome = await sendDataLakeSpendNotification(baseEvent, { ...deps, sendTimeoutMs: 10 });

    expect(outcome).toBe('failed');
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.deleteNotification).toHaveBeenCalledWith('notif-1');
    expect(deps.markDelivered).not.toHaveBeenCalled();
  });

  it('does NOT delete the claim when the timeout fires mid-dispatch - a slow-but-working mailer must not be re-sent to (B1)', async () => {
    // The failure mode this guards: sendEmail is genuinely slow, not hung - it resolves AFTER
    // the race times out. Deleting here would free the claim for a re-send of mail that is
    // still going to be delivered by this same, still-running (abandoned, not cancelled) call.
    const deps = makeDeps();
    let resolveSend: () => void = () => {};
    deps.sendEmail.mockImplementation(
      () =>
        new Promise<undefined>(resolve => {
          resolveSend = () => resolve(undefined);
        })
    );

    const outcome = await sendDataLakeSpendNotification(baseEvent, { ...deps, sendTimeoutMs: 10 });

    expect(outcome).toBe('failed');
    expect(deps.deleteNotification).not.toHaveBeenCalled();

    // The abandoned send eventually completes - its OWN markDelivered call records the real
    // outcome, which is only possible because the claim was left standing above.
    resolveSend();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(deps.markDelivered).toHaveBeenCalledWith('notif-1', {
      recipientUserIds: ['u1'],
      deliveredCount: 1,
      deliveryFailed: false,
    });
  });

  it('never throws if the re-arm delete itself fails when nothing was dispatched - the claim just stands', async () => {
    const deps = makeDeps();
    h.resolveLakeSpendAddressees.mockImplementation(() => new Promise(() => {}));
    deps.deleteNotification.mockRejectedValue(new Error('mongo down'));

    await expect(sendDataLakeSpendNotification(baseEvent, { ...deps, sendTimeoutMs: 10 })).resolves.toBe('failed');
  });

  it('reads the lake exactly once and threads it into addressee resolution (S3)', async () => {
    const deps = makeDeps();

    await sendDataLakeSpendNotification(baseEvent, deps);

    // The only dataLakes.findById call across the whole send is this one, made before the
    // claim (for organizationId denormalization) - resolveLakeSpendAddressees must be handed
    // this same lake instead of re-fetching it (see its own "uses a prefetched lake" test).
    expect(deps.db.dataLakes.findById).toHaveBeenCalledTimes(1);
    expect(h.resolveLakeSpendAddressees).toHaveBeenCalledWith(baseEvent.dataLakeId, deps.db, deps.logger, {
      id: 'lake-1',
      name: 'My Lake',
      organizationId: null,
    });
  });

  it('renders BEFORE claiming, so an unhandled kind/scope pair never creates a claim row to delete/re-arm', async () => {
    // If the claim were taken first, a render throw would land in the not-dispatched catch and
    // delete the just-created claim - re-arming it for the next message to hit the same
    // unhandled pair and repeat forever. Rendering first means no claim ever exists for this case.
    const deps = makeDeps();
    const unhandledEvent = { ...baseEvent, kind: 'stopped' as const, scope: 'lake' as const };

    const outcome = await sendDataLakeSpendNotification(unhandledEvent, deps);

    expect(outcome).toBe('failed');
    expect(deps.claimNotification).not.toHaveBeenCalled();
    expect(deps.deleteNotification).not.toHaveBeenCalled();
  });
});
