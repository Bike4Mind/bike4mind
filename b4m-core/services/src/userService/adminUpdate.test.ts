import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adminUpdateUser } from './adminUpdate';

const ADMIN_ID = 'admin-1';
const TARGET_ID = 'user-1';

/**
 * Builds mock adapters with a mutable target balance so the real
 * addCredits/subtractCredits primitives run end-to-end (transaction record +
 * atomic increment) against in-memory fakes.
 */
function makeAdapters(startingCredits: number, { withCreditTransactions = true } = {}) {
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
      setModerationStatus: vi.fn().mockResolvedValue(undefined),
      incrementCredits,
    },
    organizations: { findById: vi.fn(), update: vi.fn() },
    friendship: {},
  };
  if (withCreditTransactions) {
    db.creditTransactions = { createTransaction };
  }
  return { adapters: { db }, createTransaction, incrementCredits, update, target };
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

  it('does not write the raw balance onto the user doc when auditing', async () => {
    const { adapters, update } = makeAdapters(100);

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150 }, adapters);

    const written = update.mock.calls[0][0];
    // The ledger increment owns the balance; the doc write must not carry the new value.
    expect(written.currentCredits).toBe(100);
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

  it('falls back to the direct overwrite when no creditTransactions adapter is wired', async () => {
    const { adapters, incrementCredits, update } = makeAdapters(100, { withCreditTransactions: false });

    await adminUpdateUser(ADMIN_ID, { id: TARGET_ID, currentCredits: 150 }, adapters);

    expect(incrementCredits).not.toHaveBeenCalled();
    // Legacy path sets the balance directly on the doc write.
    expect(update.mock.calls[0][0].currentCredits).toBe(150);
  });
});
