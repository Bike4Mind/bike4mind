import { CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deductCredits,
  userFindById,
  orgFindById,
  userIncrement,
  orgIncrement,
  pendingHolds,
  recordHold,
  claimHold,
  withTransaction,
} = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
  pendingHolds: new Map<string, unknown>(),
  recordHold: vi.fn(),
  claimHold: vi.fn(),
  withTransaction: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('@server/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {
    statusCode = 400;
  },
}));
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: {},
  organizationRepository: { findById: orgFindById, incrementCredits: orgIncrement },
  userRepository: { findById: userFindById, incrementCredits: userIncrement },
  pendingCreditHoldRepository: { record: recordHold, claim: claimHold },
  withTransaction,
}));
vi.mock('@bike4mind/services', async () => {
  const creditService = await vi.importActual<typeof import('@bike4mind/services/creditService')>(
    '@bike4mind/services/creditService'
  );
  const services = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    organizationService: { isCurrentOrgMember: services.organizationService.isCurrentOrgMember },
    creditService: { ...creditService, deductCreditsWithOrgSupport: deductCredits },
  };
});

import { CREDIT_HOLD_TTL_MS, reserveRequestCredits, type CreditLedgerEntry } from './reserveRequestCredits';

const logger = { error: vi.fn(), warn: vi.fn() };

const userReq = (apiKeyInfo?: unknown) =>
  ({ user: { id: 'u1', organizationId: null }, apiKeyInfo, logger }) as unknown as Parameters<
    typeof reserveRequestCredits
  >[0]['req'];
const ledger: CreditLedgerEntry = { type: 'sound_effects_usage', sessionId: 's1', model: 'm', source: 'api' };

describe('reserveRequestCredits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFindById.mockResolvedValue({ id: 'u1', isAdmin: false });
    let balance = 100;
    userIncrement.mockImplementation(async (_id: string, delta: number) => ({ currentCredits: (balance += delta) }));
    deductCredits.mockResolvedValue(undefined);
    pendingHolds.clear();
    let nextId = 0;
    recordHold.mockImplementation(async (hold: object, featureLabel: string, expiresAt: Date) => {
      const pending = { ...hold, id: `hold-${++nextId}`, featureLabel, expiresAt };
      pendingHolds.set(pending.id, pending);
      return pending;
    });
    claimHold.mockImplementation(async (id: string) => {
      const pending = pendingHolds.get(id) ?? null;
      pendingHolds.delete(id);
      return pending;
    });
  });

  it('reserves nothing and touches no balance when credits are not enforced', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 5,
      enforceCredits: false,
      featureLabel: 'embeddings',
    });

    expect(reservation).toMatchObject({ ownerId: 'u1', ownerType: CreditHolderType.User, reservedCredits: 0 });
    expect(await reservation.settle(5, ledger)).toBe(0);
    expect(userFindById).not.toHaveBeenCalled();
    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('refunds the over-reservation and writes the ledger row for what was kept', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    expect(userIncrement).toHaveBeenLastCalledWith('u1', -3);

    expect(await reservation.settle(1, ledger)).toBe(1);

    expect(userIncrement).toHaveBeenLastCalledWith('u1', 2);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 1, type: 'sound_effects_usage' }),
      expect.anything(),
      // The ledger row must see the post-refund balance, not the reservation's.
      { skipBalanceUpdate: true, currentCreditHolder: { currentCredits: 99 } }
    );
  });

  it('still settles and writes the ledger row when the partial refund fails', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockRejectedValueOnce(new Error('db down'));

    expect(await reservation.settle(1, ledger)).toBe(1);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('over-reserved credit refund failed'),
      expect.objectContaining({ overReserved: 2 })
    );
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 1 }),
      expect.anything(),
      // No refund landed, so the ledger row carries the reservation's balance.
      { skipBalanceUpdate: true, currentCreditHolder: { currentCredits: 97 } }
    );
  });

  it('writes no ledger row when the settled charge rounds to zero, and refunds it all', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 1,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });

    expect(await reservation.settle(0, ledger)).toBe(0);
    expect(userIncrement).toHaveBeenLastCalledWith('u1', 1);
    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('never keeps more than it reserved', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 2,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });

    expect(await reservation.settle(9, ledger)).toBe(2);
    expect(deductCredits).toHaveBeenCalledWith(
      expect.objectContaining({ credits: 2 }),
      expect.anything(),
      expect.anything()
    );
  });

  it('logs a failed refund with the owner instead of throwing it', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockRejectedValueOnce(new Error('db down'));

    await expect(reservation.refund()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('embeddings refund failed'),
      expect.objectContaining({ ownerId: 'u1', reservedCredits: 3, error: 'db down' })
    );
  });

  it('rolls back and rejects when the reservation overdraws the pool', async () => {
    let balance = 1;
    userIncrement.mockImplementation(async (_id: string, delta: number) => ({ currentCredits: (balance += delta) }));

    await expect(
      reserveRequestCredits({ req: userReq(), requiredCredits: 3, enforceCredits: true, featureLabel: 'embeddings' })
    ).rejects.toThrow('You do not have enough credits for embeddings. You currently have 1 credits');
    expect(userIncrement).toHaveBeenLastCalledWith('u1', 3);
  });

  it('bills the organization pool for an org-billed API key', async () => {
    orgFindById.mockResolvedValue({ id: 'o1', currentCredits: 50, userDetails: [], users: [{ userId: 'u1' }] });
    orgIncrement.mockResolvedValue({ currentCredits: 50 });

    const reservation = await reserveRequestCredits({
      req: userReq({ billingOwnerType: CreditHolderType.Organization, organizationId: 'o1' }),
      requiredCredits: 2,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });

    expect(reservation).toMatchObject({ ownerId: 'o1', ownerType: CreditHolderType.Organization });
    expect(orgIncrement).toHaveBeenCalledWith('o1', -2);
    expect(userIncrement).not.toHaveBeenCalled();
  });

  it('records the hold with an expiry before returning the reservation', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    try {
      await reserveRequestCredits({
        req: userReq(),
        requiredCredits: 3,
        enforceCredits: true,
        featureLabel: 'embeddings',
      });
    } finally {
      vi.useRealTimers();
    }

    expect(recordHold).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ownerId: 'u1', reservedCredits: 3, balanceAfterHold: 97 }),
      'embeddings',
      new Date(Date.parse('2026-10-19T12:00:00Z') + CREDIT_HOLD_TTL_MS)
    );
  });

  it('records nothing when credits are not enforced', async () => {
    await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: false,
      featureLabel: 'embeddings',
    });

    expect(recordHold).not.toHaveBeenCalled();
  });

  it('moves the balance and records the hold in one transaction, failing the request if the record fails', async () => {
    recordHold.mockRejectedValueOnce(new Error('db down'));

    await expect(
      reserveRequestCredits({ req: userReq(), requiredCredits: 3, enforceCredits: true, featureLabel: 'embeddings' })
    ).rejects.toThrow('db down');
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(userIncrement).toHaveBeenCalledExactlyOnceWith('u1', -3);
    expect(recordHold.mock.invocationCallOrder[0]).toBeGreaterThan(userIncrement.mock.invocationCallOrder[0]);
  });

  it('claims the hold on settle so the sweep can no longer refund it', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });

    await reservation.settle(1, ledger);

    expect(claimHold).toHaveBeenCalledExactlyOnceWith('hold-1');
    expect(pendingHolds.size).toBe(0);
  });

  it('moves no credits when the sweep already refunded the hold', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    pendingHolds.clear();
    userIncrement.mockClear();

    expect(await reservation.settle(1, ledger)).toBe(0);
    await reservation.refund();

    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('embeddings settle found its credit hold already swept'),
      expect.objectContaining({ holdId: 'hold-1', reservedCredits: 3 })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('embeddings refund found its credit hold already swept'),
      {
        holdId: 'hold-1',
      }
    );
  });

  it('refunds only once when refund is called twice', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockClear();

    await reservation.refund();
    await reservation.refund();

    expect(userIncrement).toHaveBeenCalledExactlyOnceWith('u1', 3);
  });

  it('claims and refunds in one transaction, leaving the hold for the sweep when it fails', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    withTransaction.mockClear();
    userIncrement.mockClear();
    claimHold.mockRejectedValueOnce(new Error('db down'));

    await expect(reservation.refund()).resolves.toBeUndefined();

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(userIncrement).not.toHaveBeenCalled();
    expect(pendingHolds.has('hold-1')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('refund failed - left for the expired-hold sweep'),
      expect.objectContaining({ holdId: 'hold-1', error: 'db down' })
    );
  });

  it('retries a settle claim that fails transiently, then settles', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    claimHold.mockRejectedValueOnce(new Error('blip')).mockRejectedValueOnce(new Error('blip'));

    expect(await reservation.settle(1, ledger)).toBe(1);
    expect(claimHold).toHaveBeenCalledTimes(3);
    expect(deductCredits).toHaveBeenCalledTimes(1);
  });

  it('charges nothing and leaves the hold for the sweep when every settle claim fails', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockClear();
    claimHold.mockRejectedValue(new Error('db down'));

    expect(await reservation.settle(1, ledger)).toBe(0);

    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(pendingHolds.has('hold-1')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('settle could not claim its credit hold'),
      expect.objectContaining({ holdId: 'hold-1', error: 'db down' })
    );
  });
});
