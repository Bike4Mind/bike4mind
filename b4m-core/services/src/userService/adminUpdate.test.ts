import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminUpdateUser, adminUpdateUserSchema } from './adminUpdate';
import { checkStorageLimit } from '@bike4mind/utils';

vi.mock('../friendshipService/sendFriendRequest', () => ({ sendFriendRequest: vi.fn() }));

const ADMIN_ID = 'admin-1';
const TARGET_ID = 'user-1';

/**
 * Builds mock adapters with a mutable target balance so the real
 * addCredits/subtractCredits primitives run end-to-end (transaction record +
 * atomic increment) against in-memory fakes.
 */
function makeAdapters(startingCredits: number) {
  const target: any = {
    id: TARGET_ID,
    currentCredits: startingCredits,
    tags: [],
  };
  const createTransaction = vi.fn().mockImplementation(async (type: string, data: any) => ({
    id: 'tx-1',
    type,
    ...data,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const incrementCredits = vi.fn().mockImplementation(async (_ownerId: string, delta: number) => {
    target.currentCredits += delta;
    return { id: TARGET_ID, currentCredits: target.currentCredits };
  });
  const update = vi.fn().mockResolvedValue(undefined);

  const db: any = {
    users: {
      findById: vi.fn().mockImplementation(async (id: string) => {
        if (id === ADMIN_ID) return { id: ADMIN_ID, isAdmin: true };
        return { ...target };
      }),
      findByIdWithPassword: vi.fn().mockImplementation(async () => target),
      update,
      existsOtherUserWithUsername: vi.fn().mockResolvedValue(false),
      existsOtherUserWithEmail: vi.fn().mockResolvedValue(false),
      setModerationStatus: vi.fn().mockResolvedValue(undefined),
      incrementCredits,
    },
    organizations: { findById: vi.fn(), update: vi.fn() },
    friendship: {},
    userApiKeys: { deactivateAllByUserId: vi.fn().mockResolvedValue(undefined) },
    realtimeConnections: { endConnections: vi.fn().mockResolvedValue({ connectionIds: [] }) },
    creditTransactions: { createTransaction },
  };
  return {
    adapters: { db },
    createTransaction,
    incrementCredits,
    update,
    target,
    deactivateAllByUserId: db.userApiKeys.deactivateAllByUserId,
    endConnections: db.realtimeConnections.endConnections,
  };
}

describe('adminUpdateUser — audited credit adjustments', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes a credit increase through a generic_add transaction recording actor, delta, and reason', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150, creditReason: 'Promo bonus' }, adapters);

    expect(createTransaction).toHaveBeenCalledTimes(1);
    const [type, data] = createTransaction.mock.calls[0];
    expect(type).toBe('generic_add');
    expect(data.credits).toBe(50); // delta
    expect(data.reason).toBe('admin_adjustment');
    expect(data.description).toBe('Promo bonus');
    expect(data.metadata).toMatchObject({
      actorId: ADMIN_ID,
      previousBalance: 100,
      resultingBalance: 150,
      note: 'Promo bonus',
    });
    // Atomic increment applies the delta, not an overwrite.
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, 50, expect.anything());
  });

  it('sets an absolute 0 balance from a positive balance as an audited deduction', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 0, creditReason: 'Abusive signup' }, adapters);

    expect(createTransaction.mock.calls[0][0]).toBe('generic_deduct');
    expect(createTransaction.mock.calls[0][1].metadata).toMatchObject({
      note: 'Abusive signup',
      previousBalance: 100,
      resultingBalance: 0,
    });
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, -100);
  });

  it('sets an absolute 0 balance from a negative balance as a grant', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(-40);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 0, creditReason: 'Reset balance' }, adapters);

    expect(createTransaction.mock.calls[0][0]).toBe('generic_add');
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, 40, expect.anything());
  });

  it('routes a credit decrease through a generic_deduct transaction', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 70 }, adapters);

    expect(createTransaction).toHaveBeenCalledTimes(1);
    const [type, data] = createTransaction.mock.calls[0];
    expect(type).toBe('generic_deduct');
    expect(data.reason).toBe('admin_adjustment');
    expect(data.description).toBe('Admin credit adjustment'); // default when no reason
    expect(data.metadata).toMatchObject({ actorId: ADMIN_ID, previousBalance: 100, resultingBalance: 70 });
    expect(data.metadata.note).toBeUndefined();
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, -30);
  });

  it('omits currentCredits entirely from the user doc write when auditing', async () => {
    const { adapters, update } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150 }, adapters);

    const written = update.mock.calls[0][0];
    // The ledger $inc runs first and owns the balance; the doc write's $set must
    // not carry currentCredits at all, or it would clobber the increment.
    expect('currentCredits' in written).toBe(false);
  });

  it('runs the ledger adjustment before the user doc write', async () => {
    const { adapters, incrementCredits, update } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150 }, adapters);

    // The audited balance change must commit before the doc write, so a ledger
    // failure cannot leave lastCreditsPurchasedAt / bundled fields stuck.
    expect(incrementCredits.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]);
  });

  it('does not persist the user doc write when the ledger adjustment fails', async () => {
    const { adapters, createTransaction, update } = makeAdapters(100);
    createTransaction.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(
      adminUpdateUser(
        ADMIN_ID,
        // Bundle a non-credit edit with the credit change: it must not stick if
        // the credit audit throws.
        { id: TARGET_ID, currentCredits: 150, tags: ['vip'], moderationStatus: 'throttled' },
        adapters
      )
    ).rejects.toThrow('ledger unavailable');

    expect(update).not.toHaveBeenCalled();
    expect(adapters.db.users.setModerationStatus).not.toHaveBeenCalled();
  });

  it('does not mutate org membership when the ledger fails on a bundled org + credit change', async () => {
    const { adapters, createTransaction, target } = makeAdapters(100);
    target.organizationId = 'org-old';
    adapters.db.organizations.findById.mockImplementation(async (id: string) => ({ id, users: [] }));
    createTransaction.mockRejectedValueOnce(new Error('ledger unavailable'));

    await expect(
      adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150, organizationId: 'org-new' }, adapters)
    ).rejects.toThrow('ledger unavailable');

    // Both orgs are validated before the ledger, but the membership writes run
    // after it, so a ledger failure must leave both org docs untouched.
    expect(adapters.db.organizations.findById).toHaveBeenCalledWith('org-old');
    expect(adapters.db.organizations.findById).toHaveBeenCalledWith('org-new');
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown organizationId before the ledger commits any balance', async () => {
    const { adapters, createTransaction, incrementCredits, update, target } = makeAdapters(100);
    target.organizationId = 'org-old';
    adapters.db.organizations.findById.mockImplementation(async (id: string) =>
      id === 'org-old' ? { id, users: [] } : null
    );

    await expect(
      adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150, organizationId: 'org-missing' }, adapters)
    ).rejects.toThrow('Organization not found');

    expect(createTransaction).not.toHaveBeenCalled();
    expect(incrementCredits).not.toHaveBeenCalled();
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(target.currentCredits).toBe(100);
  });

  it('rejects an unknown current organization before the ledger commits any balance', async () => {
    const { adapters, createTransaction, incrementCredits, update, target } = makeAdapters(100);
    target.organizationId = 'org-gone';
    adapters.db.organizations.findById.mockImplementation(async (id: string) =>
      id === 'org-new' ? { id, users: [] } : null
    );

    await expect(
      adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150, organizationId: 'org-new' }, adapters)
    ).rejects.toThrow('Organization not found');

    expect(createTransaction).not.toHaveBeenCalled();
    expect(incrementCredits).not.toHaveBeenCalled();
    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(target.currentCredits).toBe(100);
  });

  it('keeps the committed ledger change when the later doc write fails', async () => {
    const { adapters, incrementCredits, update } = makeAdapters(100);
    update.mockRejectedValueOnce(new Error('doc write failed'));

    await expect(
      adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150, moderationStatus: 'throttled' }, adapters)
    ).rejects.toThrow('doc write failed');

    // Inverse trade-off: the balance change is already committed and auditable;
    // only the doc write and the moderation transition (which run after it) are
    // skipped. The balance stays self-consistent with its CreditTransaction.
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, 50, expect.anything());
    expect(adapters.db.users.setModerationStatus).not.toHaveBeenCalled();
  });

  it('writes no transaction when credits are unchanged', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 100, creditReason: 'noop' }, adapters);

    expect(createTransaction).not.toHaveBeenCalled();
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('writes no transaction when currentCredits is not part of the update', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, tags: ['vip'] }, adapters);

    expect(createTransaction).not.toHaveBeenCalled();
    expect(incrementCredits).not.toHaveBeenCalled();
  });

  it('never writes currentCredits on the doc, so the ledger is the only balance writer', async () => {
    const { adapters, createTransaction, update } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150 }, adapters);

    expect(createTransaction).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).not.toHaveProperty('currentCredits');
  });

  it('returns the applied credit adjustment for the caller to audit', async () => {
    const { adapters } = makeAdapters(100);

    const result = await adminUpdateUser(
      ADMIN_ID,
      { id: TARGET_ID, creditDelta: -150, creditReason: ' Refund chargeback ' },
      adapters
    );

    // The floor clamps the deduction to the balance; the returned delta is what was applied.
    expect(result.creditAdjustment).toEqual({
      credits: -100,
      previousBalance: 100,
      resultingBalance: 0,
      note: 'Refund chargeback',
      creditTransactionId: 'tx-1',
    });
  });

  it('links a grant to the ledger row it wrote', async () => {
    const { adapters, createTransaction } = makeAdapters(100);
    createTransaction.mockResolvedValueOnce({ id: 'tx-grant' });

    const result = await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: 50 }, adapters);

    expect(result.creditAdjustment?.creditTransactionId).toBe('tx-grant');
  });

  it('links a deduction to the ledger row it wrote', async () => {
    const { adapters, createTransaction } = makeAdapters(100);
    createTransaction.mockResolvedValueOnce({ id: 'tx-deduct' });

    const result = await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: -30 }, adapters);

    expect(result.creditAdjustment?.creditTransactionId).toBe('tx-deduct');
  });

  it('returns no credit adjustment when the balance does not change', async () => {
    const { adapters } = makeAdapters(100);

    const result = await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, tags: ['vip'] }, adapters);

    expect(result.creditAdjustment).toBeNull();
  });
});

describe('adminUpdateUser - signed creditDelta path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes a positive creditDelta through a generic_add and stamps lastCreditsPurchasedAt', async () => {
    const { adapters, createTransaction, incrementCredits, update } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: 50, creditReason: 'Bonus' }, adapters);

    const [type, data] = createTransaction.mock.calls[0];
    expect(type).toBe('generic_add');
    expect(data.credits).toBe(50);
    expect(data.metadata).toMatchObject({ actorId: ADMIN_ID, previousBalance: 100, resultingBalance: 150 });
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, 50, expect.anything());
    // A grant stamps the purchase timestamp even though the UI sends only creditDelta.
    expect(update.mock.calls[0][0].lastCreditsPurchasedAt).toBeInstanceOf(Date);
  });

  it('routes a negative creditDelta through a generic_deduct', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: -30 }, adapters);

    expect(createTransaction.mock.calls[0][0]).toBe('generic_deduct');
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, -30);
  });

  it('rejects a deduction from a non-positive balance without writing anything', async () => {
    const { adapters, createTransaction, incrementCredits, update, target } = makeAdapters(-100);

    await expect(adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: -50 }, adapters)).rejects.toThrow(
      'Balance is already at or below zero; nothing to deduct'
    );

    expect(createTransaction).not.toHaveBeenCalled();
    expect(incrementCredits).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(target.currentCredits).toBe(-100);
  });

  it('applies creditDelta and ignores currentCredits when both are passed', async () => {
    const { adapters, createTransaction, incrementCredits } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: 20, currentCredits: 500 }, adapters);

    expect(createTransaction.mock.calls[0][0]).toBe('generic_add');
    expect(incrementCredits).toHaveBeenCalledWith(TARGET_ID, 20, expect.anything());
  });

  it('rejects negative absolute and oversized credit values', () => {
    const base = { id: TARGET_ID };
    expect(adminUpdateUserSchema.safeParse({ ...base, currentCredits: -5 }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, currentCredits: 1e308 }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, creditDelta: -1e308 }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, currentCredits: 12.5 }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, creditDelta: 0.5 }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, currentCredits: Infinity }).success).toBe(false);
    expect(adminUpdateUserSchema.safeParse({ ...base, currentCredits: 0, creditDelta: -50 }).success).toBe(true);
  });
});

describe('adminUpdateUser - lastCreditsPurchasedAt', () => {
  const PRIOR_PURCHASE = new Date('2024-01-01T00:00:00.000Z');

  beforeEach(() => vi.clearAllMocks());

  it('omits lastCreditsPurchasedAt from the write when an admin deduction leaves a positive balance', async () => {
    const { adapters, update, target } = makeAdapters(12000);
    target.lastCreditsPurchasedAt = PRIOR_PURCHASE;

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 9500 }, adapters);

    // The new balance is positive and changed, but it decreased - a clawback is not a purchase.
    expect('lastCreditsPurchasedAt' in update.mock.calls[0][0]).toBe(false);
  });

  it('omits lastCreditsPurchasedAt from the write for a negative creditDelta', async () => {
    const { adapters, update, target } = makeAdapters(12000);
    target.lastCreditsPurchasedAt = PRIOR_PURCHASE;

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, creditDelta: -2500 }, adapters);

    expect('lastCreditsPurchasedAt' in update.mock.calls[0][0]).toBe(false);
  });

  it('strips throttleTier and throttleReason from the doc write', async () => {
    const { adapters, update } = makeAdapters(100);

    await adminUpdateUser(
      ADMIN_ID,
      { id: TARGET_ID, tags: ['vip'], throttleTier: 'shadow', throttleReason: 'bulk signups' },
      adapters
    );

    const written = update.mock.calls[0][0];
    expect(written).toHaveProperty('tags');
    expect(written).not.toHaveProperty('throttleTier');
    expect(written).not.toHaveProperty('throttleReason');
  });

  it('leaves a blank throttleReason for the route to reject as a 400', () => {
    expect(
      adminUpdateUserSchema.safeParse({ id: TARGET_ID, throttleTier: 'shadow', throttleReason: '   ' }).success
    ).toBe(true);
  });

  it('omits lastCreditsPurchasedAt from the write for an edit that touches no credits', async () => {
    const { adapters, update, target } = makeAdapters(12000);
    target.lastCreditsPurchasedAt = PRIOR_PURCHASE;

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, tags: ['vip'] }, adapters);

    // Carrying the snapshot value on an unrelated save would $set it back over a purchase
    // stamp committed between this request's read and its write.
    expect('lastCreditsPurchasedAt' in update.mock.calls[0][0]).toBe(false);
  });

  it('stamps lastCreditsPurchasedAt when an admin grant increases the balance', async () => {
    const { adapters, update, target } = makeAdapters(12000);
    target.lastCreditsPurchasedAt = PRIOR_PURCHASE;

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 14500 }, adapters);

    const stamped = update.mock.calls[0][0].lastCreditsPurchasedAt;
    expect(stamped).toBeInstanceOf(Date);
    expect(stamped.getTime()).toBeGreaterThan(PRIOR_PURCHASE.getTime());
  });

  it('drops a caller-supplied lastCreditsPurchasedAt on a non-grant save', async () => {
    const { adapters, update, target } = makeAdapters(12000);
    target.lastCreditsPurchasedAt = PRIOR_PURCHASE;

    // Server-owned metadata: it is no longer in the schema, so secureParameters strips it
    // regardless of what a caller sends - `as any` simulates a raw request body doing so.
    await adminUpdateUser(
      ADMIN_ID,
      { id: TARGET_ID, tags: ['vip'], lastCreditsPurchasedAt: null } as unknown as Parameters<
        typeof adminUpdateUser
      >[1],
      adapters
    );

    expect('lastCreditsPurchasedAt' in update.mock.calls[0][0]).toBe(false);
  });
});

describe('adminUpdateUser - preferences merge', () => {
  beforeEach(() => vi.clearAllMocks());

  it('merges a partial preferences write instead of replacing the stored object', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.preferences = { language: 'en', showDebug: true, experimentalFeatures: { agentMode: true } };

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, preferences: { showDebug: false } }, adapters);

    expect(update.mock.calls[0][0].preferences).toEqual({
      language: 'en',
      showDebug: false,
      experimentalFeatures: { agentMode: true },
    });
  });
});

describe('adminUpdateUser - username changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a changed username outside the allowed characters', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.username = 'oldname';

    await expect(adminUpdateUser(ADMIN_ID, { id: TARGET_ID, username: 'bad<name>' }, adapters)).rejects.toThrow(
      "Usernames can contain letters, numbers, spaces and . _ - ' (up to 64 characters)."
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a username another account holds', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.username = 'oldname';
    adapters.db.users.existsOtherUserWithUsername.mockResolvedValue(true);

    await expect(adminUpdateUser(ADMIN_ID, { id: TARGET_ID, username: 'Taken' }, adapters)).rejects.toThrow(
      'That username is taken.'
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('writes a valid changed username trimmed', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.username = 'oldname';

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, username: ' New Name ' }, adapters);

    expect(update.mock.calls[0][0].username).toBe('New Name');
  });

  it('lets an admin give an account the reserved test-persona prefix', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.username = 'oldname';

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, username: 'persona-seed' }, adapters);

    expect(update.mock.calls[0][0].username).toBe('persona-seed');
  });
});

describe('adminUpdateUser - email changes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the email trimmed and lowercased after checking availability', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.email = 'old@x.com';

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, email: ' New@X.com ' }, adapters);

    expect(adapters.db.users.existsOtherUserWithEmail).toHaveBeenCalledWith('new@x.com', TARGET_ID);
    expect(update.mock.calls[0][0].email).toBe('new@x.com');
  });

  it('rejects an address another account holds with a 409', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.email = 'old@x.com';
    adapters.db.users.existsOtherUserWithEmail.mockResolvedValue(true);

    const error = await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, email: 'taken@x.com' }, adapters).catch(
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ statusCode: 409, message: 'That email address is already in use.' });
    expect(update).not.toHaveBeenCalled();
  });

  it('maps a duplicate-key error on email from the write to the same 409', async () => {
    const { adapters, update, target } = makeAdapters(100);
    target.email = 'old@x.com';
    update.mockRejectedValue(Object.assign(new Error('E11000'), { code: 11000, keyPattern: { email: 1 } }));

    const error = await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, email: 'new@x.com' }, adapters).catch(
      (caught: unknown) => caught
    );

    expect(error).toMatchObject({ statusCode: 409, message: 'That email address is already in use.' });
  });
});

describe('adminUpdateUser - API key deactivation on entering a blocked state', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['ban', {}, { isBanned: true }],
    ['dispute', {}, { disputePending: true }],
    ['suspension', { moderation: { status: 'active' } }, { moderationStatus: 'suspended' as const }],
    ['ban and suspension in one save', {}, { isBanned: true, moderationStatus: 'suspended' as const }],
  ])('deactivates once on %s', async (_label, seed, patch) => {
    const { adapters, target, deactivateAllByUserId, endConnections } = makeAdapters(100);
    Object.assign(target, seed);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, ...patch }, adapters);

    expect(deactivateAllByUserId).toHaveBeenCalledTimes(1);
    expect(deactivateAllByUserId).toHaveBeenCalledWith(TARGET_ID);
    // Every realtime connection ends with the account, API-key ones included.
    expect(endConnections).toHaveBeenCalledTimes(1);
    expect(endConnections).toHaveBeenCalledWith({ userId: TARGET_ID });
  });

  it.each([
    ['an unrelated update', {}, { name: 'New Name' }],
    ['re-banning a banned user', { isBanned: true }, { isBanned: true }],
    ['re-flagging a disputed user', { disputePending: true }, { disputePending: true }],
    [
      're-suspending a suspended user',
      { moderation: { status: 'suspended' } },
      { moderationStatus: 'suspended' as const },
    ],
    ['suspend_pending', {}, { moderationStatus: 'suspend_pending' as const }],
    ['throttled', {}, { moderationStatus: 'throttled' as const }],
    ['active', { moderation: { status: 'suspended' } }, { moderationStatus: 'active' as const }],
    ['unban', { isBanned: true }, { isBanned: false }],
  ])('does not touch keys on %s', async (_label, seed, patch) => {
    const { adapters, target, deactivateAllByUserId, endConnections } = makeAdapters(100);
    Object.assign(target, seed);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, ...patch }, adapters);

    expect(deactivateAllByUserId).not.toHaveBeenCalled();
    expect(endConnections).not.toHaveBeenCalled();
  });

  it('does not deactivate when the user write fails', async () => {
    const { adapters, update, deactivateAllByUserId } = makeAdapters(100);
    update.mockRejectedValueOnce(new Error('write failed'));

    await expect(adminUpdateUser(ADMIN_ID, { id: TARGET_ID, isBanned: true }, adapters)).rejects.toThrow(
      'write failed'
    );
    expect(deactivateAllByUserId).not.toHaveBeenCalled();
  });
});

describe('adminUpdateUser - org move membership row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds a read row for a target not yet in the new org', async () => {
    const { adapters } = makeAdapters(100);
    adapters.db.organizations.findById.mockResolvedValue({ id: 'org-new', userId: 'owner-1', users: [] });

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, organizationId: 'org-new' }, adapters);

    expect(adapters.db.organizations.update).toHaveBeenCalledWith({
      id: 'org-new',
      users: [{ userId: TARGET_ID, permissions: ['read'] }],
    });
  });

  it('merges read into an existing row instead of adding a duplicate', async () => {
    const { adapters } = makeAdapters(100);
    adapters.db.organizations.findById.mockResolvedValue({
      id: 'org-new',
      userId: 'owner-1',
      users: [{ userId: TARGET_ID, permissions: ['admin'] }],
    });

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, organizationId: 'org-new' }, adapters);

    expect(adapters.db.organizations.update).toHaveBeenCalledWith({
      id: 'org-new',
      users: [{ userId: TARGET_ID, permissions: ['admin', 'read'] }],
    });
  });

  it('keeps the other members when merging the target row', async () => {
    const { adapters } = makeAdapters(100);
    adapters.db.organizations.findById.mockResolvedValue({
      id: 'org-new',
      userId: 'owner-1',
      users: [
        { userId: 'other-1', permissions: ['read', 'write'] },
        { userId: TARGET_ID, permissions: ['admin'] },
      ],
    });

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, organizationId: 'org-new' }, adapters);

    expect(adapters.db.organizations.update).toHaveBeenCalledWith({
      id: 'org-new',
      users: [
        { userId: 'other-1', permissions: ['read', 'write'] },
        { userId: TARGET_ID, permissions: ['admin', 'read'] },
      ],
    });
  });

  it('adds no row when the target owns the new org', async () => {
    const { adapters, update } = makeAdapters(100);
    adapters.db.organizations.findById.mockResolvedValue({ id: 'org-new', userId: TARGET_ID, users: [] });

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, organizationId: 'org-new' }, adapters);

    expect(adapters.db.organizations.update).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });
});

describe('adminUpdateUser storage overrides', () => {
  it('writes an override and effective limit together, preserving usage', async () => {
    const { adapters, target, update } = makeAdapters(100);
    Object.assign(target, { storageLimit: 5000, planStorageLimit: 5000, currentStorageSize: 8_000_000_000 });
    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, storageLimitOverride: 250.5 }, adapters);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TARGET_ID,
        storageLimitOverride: 250.5,
        storageLimit: 250.5,
      })
    );
    expect(update.mock.calls[0][0]).not.toHaveProperty('currentStorageSize');
    expect(update.mock.calls[0][0]).not.toHaveProperty('planStorageLimit');
    const persisted = { ...target, ...update.mock.calls[0][0] };
    await expect(checkStorageLimit(persisted, 1)).rejects.toThrow('File size exceeds storage limit');
    expect(persisted.currentStorageSize).toBe(8_000_000_000);
  });

  it.each([
    [5000, 5000],
    [null, 1000],
  ])('clears to plan %s or default %s', async (plan, expected) => {
    const { adapters, target, update } = makeAdapters(100);
    Object.assign(target, { storageLimit: 2500, storageLimitOverride: 2500, planStorageLimit: plan });
    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, storageLimitOverride: null }, adapters);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ storageLimitOverride: null, storageLimit: expected })
    );
  });

  it('maps the legacy admin input to an explicit override', async () => {
    const { adapters, update } = makeAdapters(100);
    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, storageLimit: 0 }, adapters);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ storageLimitOverride: 0, storageLimit: 0 }));
  });

  it('does not rewrite quota on unrelated edits', async () => {
    const { adapters, update } = makeAdapters(100);
    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, name: 'Updated' }, adapters);
    expect(update.mock.calls[0][0]).not.toHaveProperty('storageLimitOverride');
    expect(update.mock.calls[0][0]).not.toHaveProperty('storageLimit');
  });

  it.each([-1, Infinity, NaN, 1_000_000_001])('rejects invalid overrides: %s', value => {
    expect(adminUpdateUserSchema.safeParse({ id: TARGET_ID, storageLimitOverride: value }).success).toBe(false);
  });
});
