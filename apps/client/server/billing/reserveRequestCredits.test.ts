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
  markSettled,
  findSettlement,
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
  markSettled: vi.fn(),
  findSettlement: vi.fn(),
  withTransaction: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  BadRequestError: class BadRequestError extends Error {
    statusCode = 400;
  },
  ForbiddenError: class ForbiddenError extends Error {
    statusCode = 403;
  },
  UnauthorizedError: class UnauthorizedError extends Error {
    statusCode = 401;
  },
}));
vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: {},
  organizationRepository: { findById: orgFindById, incrementCredits: orgIncrement },
  userRepository: { findById: userFindById, incrementCredits: userIncrement },
  pendingCreditHoldRepository: { record: recordHold, claim: claimHold, markSettled, findSettlement },
  usageEventRepository: {},
  withTransaction,
}));
const checkDailyCap = vi.hoisted(() => vi.fn());
vi.mock('./freeTierDailyCapGate', () => ({ checkFreeTierDailySpendCap: checkDailyCap }));
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

import {
  CREDIT_HOLD_TTL_MS,
  reserveRequestCredits,
  settleHeldCredits,
  type CreditLedgerEntry,
} from './reserveRequestCredits';

const logger = { error: vi.fn(), warn: vi.fn() };

const userReq = (apiKeyInfo?: unknown) =>
  ({ user: { id: 'u1', organizationId: null }, apiKeyInfo, logger }) as unknown as Parameters<
    typeof reserveRequestCredits
  >[0]['req'];
const ledger: CreditLedgerEntry = { type: 'sound_effects_usage', sessionId: 's1', model: 'm', source: 'api' };

describe('reserveRequestCredits', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    withTransaction.mockImplementation(async callback => {
      const snapshot = new Map(pendingHolds);
      try {
        return await callback();
      } catch (error) {
        pendingHolds.clear();
        for (const [id, hold] of snapshot) pendingHolds.set(id, hold);
        throw error;
      }
    });
    markSettled.mockImplementation(async (id: string, credits: number) => {
      const pending = pendingHolds.get(id);
      if (!pending || (typeof pending === 'object' && 'settledCredits' in pending)) return false;
      pendingHolds.set(id, { ...(pending as object), settledCredits: credits });
      return true;
    });
    findSettlement.mockImplementation(async (id: string) => {
      const pending = pendingHolds.get(id);
      return pending && typeof pending === 'object' && 'settledCredits' in pending ? pending.settledCredits : null;
    });
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
      if (pending && typeof pending === 'object' && 'settledCredits' in pending) return null;
      pendingHolds.delete(id);
      return pending;
    });
  });

  it.each([true, false])(
    'refuses a moderated user before touching any balance (enforceCredits %s)',
    async enforceCredits => {
      const req = {
        ...userReq(),
        user: { id: 'u1', organizationId: null, isModerated: true },
      } as unknown as Parameters<typeof reserveRequestCredits>[0]['req'];

      await expect(
        reserveRequestCredits({ req, requiredCredits: 5, enforceCredits, featureLabel: 'embeddings' })
      ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('AI features are disabled') });
      expect(userIncrement).not.toHaveBeenCalled();
      expect(recordHold).not.toHaveBeenCalled();
    }
  );

  it('refuses a capped free-tier user before reserving anything', async () => {
    const capError = new Error('Daily free-tier credit limit reached.');
    checkDailyCap.mockRejectedValueOnce(capError);
    const req = userReq();

    await expect(
      reserveRequestCredits({ req, requiredCredits: 5, enforceCredits: true, featureLabel: 'embeddings' })
    ).rejects.toBe(capError);
    expect(checkDailyCap).toHaveBeenCalledWith(expect.objectContaining({ user: req.user }));
    expect(userIncrement).not.toHaveBeenCalled();
    expect(recordHold).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'refuses a signup review hold before any billing (enforceCredits %s)',
    async enforceCredits => {
      const req = userReq({ keyId: 'key1', billingOwnerType: CreditHolderType.User });
      req.user = {
        ...req.user!,
        riskScore: { score: 70, signals: [], computedAt: new Date(), reviewState: 'pending' },
      };
      await expect(
        reserveRequestCredits({ req, requiredCredits: 5, enforceCredits, featureLabel: 'embeddings' })
      ).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('awaits review') });
      expect(checkDailyCap).not.toHaveBeenCalled();
      expect(userIncrement).not.toHaveBeenCalled();
      expect(orgIncrement).not.toHaveBeenCalled();
      expect(recordHold).not.toHaveBeenCalled();
    }
  );

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

  it('retries the whole settlement when the partial refund fails', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockRejectedValueOnce(new Error('db down'));

    expect(await reservation.settle(1, ledger)).toBe(1);
    expect(markSettled).toHaveBeenCalledTimes(2);
    expect(deductCredits).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ credits: 1 }), expect.anything(), {
      skipBalanceUpdate: true,
      currentCreditHolder: { currentCredits: 99 },
    });
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

  describe('explicit billingOrganizationId (JWT caller)', () => {
    const homeOrgReq = () =>
      ({ user: { id: 'u1', organizationId: 'homeOrg' }, logger }) as unknown as Parameters<
        typeof reserveRequestCredits
      >[0]['req'];
    const base = { requiredCredits: 5, enforceCredits: true, featureLabel: 'sound generation' };

    beforeEach(() => {
      orgFindById.mockImplementation(async (id: string) => ({
        id,
        currentCredits: 50,
        userDetails: [],
        users: [{ userId: 'u1' }],
      }));
      orgIncrement.mockResolvedValue({ currentCredits: 50 });
    });

    it('bills the explicit org instead of the home org', async () => {
      const reservation = await reserveRequestCredits({
        ...base,
        req: homeOrgReq(),
        billingOrganizationId: 'teamOrg',
      });

      expect(reservation).toMatchObject({ ownerId: 'teamOrg', ownerType: CreditHolderType.Organization });
      expect(checkDailyCap).toHaveBeenCalledWith(expect.objectContaining({ billingOrganizationId: 'teamOrg' }));
      expect(orgIncrement).toHaveBeenCalledWith('teamOrg', -5);
      expect(userIncrement).not.toHaveBeenCalled();
    });

    it('bills the user when null, even with a home-org seat', async () => {
      const reservation = await reserveRequestCredits({ ...base, req: homeOrgReq(), billingOrganizationId: null });

      expect(reservation).toMatchObject({ ownerId: 'u1', ownerType: CreditHolderType.User });
      expect(checkDailyCap).toHaveBeenCalledWith(expect.objectContaining({ billingOrganizationId: undefined }));
      expect(userIncrement).toHaveBeenCalledWith('u1', -5);
      expect(orgIncrement).not.toHaveBeenCalled();
    });

    it('keeps the home-org fallback when omitted', async () => {
      const reservation = await reserveRequestCredits({ ...base, req: homeOrgReq() });

      expect(reservation).toMatchObject({ ownerId: 'homeOrg', ownerType: CreditHolderType.Organization });
    });

    it('ignores the param for an API key, whose target is fixed', async () => {
      orgFindById.mockResolvedValue({ id: 'o1', currentCredits: 50, userDetails: [], users: [{ userId: 'u1' }] });

      const reservation = await reserveRequestCredits({
        ...base,
        req: userReq({ billingOwnerType: CreditHolderType.Organization, organizationId: 'o1' }),
        billingOrganizationId: 'teamOrg',
      });

      expect(reservation).toMatchObject({ ownerId: 'o1', ownerType: CreditHolderType.Organization });
      expect(checkDailyCap).toHaveBeenCalledWith(expect.objectContaining({ billingOrganizationId: 'o1' }));
      expect(orgIncrement).toHaveBeenCalledWith('o1', -5);
    });
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
    expect(checkDailyCap).toHaveBeenCalledWith(expect.objectContaining({ billingOrganizationId: 'o1' }));
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

  it('records the settlement receipt so the sweep can no longer refund it', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });

    await reservation.settle(1, ledger);

    expect(markSettled).toHaveBeenCalledExactlyOnceWith('hold-1', 1);
    expect(await findSettlement('hold-1')).toBe(1);
    expect(await claimHold('hold-1')).toBeNull();
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

  it('retries a settlement transition that fails transiently, then settles', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    markSettled.mockRejectedValueOnce(new Error('blip')).mockRejectedValueOnce(new Error('blip'));

    expect(await reservation.settle(1, ledger)).toBe(1);
    expect(markSettled).toHaveBeenCalledTimes(3);
    expect(deductCredits).toHaveBeenCalledTimes(1);
  });

  it('charges nothing and leaves the hold for the sweep when every settlement fails', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    userIncrement.mockClear();
    markSettled.mockRejectedValue(new Error('db down'));

    expect(await reservation.settle(1, ledger)).toBe(0);

    expect(userIncrement).not.toHaveBeenCalled();
    expect(deductCredits).not.toHaveBeenCalled();
    expect(pendingHolds.has('hold-1')).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('settle could not confirm outcome - any pending hold remains refundable'),
      expect.objectContaining({ holdId: 'hold-1', error: 'db down' })
    );
  });
  it('recovers a zero-charge settlement after its commit acknowledgement is lost', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 1,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    withTransaction.mockImplementationOnce(async callback => {
      await callback();
      throw new Error('commit reply lost');
    });

    expect(await reservation.settle(0, ledger)).toBe(0);
    expect(userIncrement).toHaveBeenLastCalledWith('u1', 1);
    expect(await findSettlement('hold-1')).toBe(0);
    expect(markSettled).toHaveBeenCalledTimes(1);
    await reservation.settle(0, ledger);
    expect(userIncrement).toHaveBeenCalledTimes(2);
  });

  it('keeps the hold refundable when all ledger writes fail', async () => {
    const reservation = await reserveRequestCredits({
      req: userReq(),
      requiredCredits: 3,
      enforceCredits: true,
      featureLabel: 'embeddings',
    });
    deductCredits.mockRejectedValue(new Error('ledger unavailable'));

    expect(await reservation.settle(3, ledger)).toBe(0);
    expect(await findSettlement('hold-1')).toBeNull();
    await reservation.refund();
    expect(userIncrement).toHaveBeenLastCalledWith('u1', 3);
  });

  describe('a hold persisted for a later settle (settleHeldCredits)', () => {
    const reserve = (holdTtlMs?: number) =>
      reserveRequestCredits({
        req: userReq(),
        requiredCredits: 3,
        enforceCredits: true,
        featureLabel: 'batch transforms',
        holdTtlMs,
      });
    const context = { featureLabel: 'batch transforms', logger: logger as never };

    it('carries the pending-hold id and expires after the requested TTL', async () => {
      vi.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
      try {
        const reservation = await reserve(26 * 60 * 60_000);
        expect(reservation.hold).toMatchObject({ pendingHoldId: 'hold-1', reservedCredits: 3 });
      } finally {
        vi.useRealTimers();
      }
      expect(recordHold.mock.calls[0][2]).toEqual(new Date(Date.parse('2026-10-19T12:00:00Z') + 26 * 60 * 60_000));
    });

    it('has no hold to persist when nothing was reserved', async () => {
      const reservation = await reserveRequestCredits({
        req: userReq(),
        requiredCredits: 3,
        enforceCredits: false,
        featureLabel: 'batch transforms',
      });
      expect(reservation.hold).toBeNull();
    });

    it('moves no balance when the sweep refunded the hold first', async () => {
      const { hold } = await reserve();
      expect(await claimHold('hold-1')).not.toBeNull();
      userIncrement.mockClear();

      expect(await settleHeldCredits(hold!, 2, ledger, { ...context, throwOnUnconfirmed: true })).toBe(0);

      expect(userIncrement).not.toHaveBeenCalled();
      expect(deductCredits).not.toHaveBeenCalled();
    });

    it('leaves the row settled so a later sweep cannot refund it', async () => {
      const { hold } = await reserve();

      expect(await settleHeldCredits(hold!, 2, ledger, context)).toBe(2);

      expect(markSettled).toHaveBeenCalledExactlyOnceWith('hold-1', 2);
      expect(await findSettlement('hold-1')).toBe(2);
      expect(await claimHold('hold-1')).toBeNull();
    });

    it('throws an unconfirmed async settlement and lets a later request retry the same hold', async () => {
      const { hold } = await reserve();
      markSettled
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce(new Error('db down'))
        .mockRejectedValueOnce(new Error('db down'));

      await expect(settleHeldCredits(hold!, 2, ledger, { ...context, throwOnUnconfirmed: true })).rejects.toThrow(
        'db down'
      );
      expect(await findSettlement('hold-1')).toBeNull();
      expect(pendingHolds.has('hold-1')).toBe(true);
      expect(deductCredits).not.toHaveBeenCalled();

      expect(await settleHeldCredits(hold!, 2, ledger, { ...context, throwOnUnconfirmed: true })).toBe(2);
      expect(await findSettlement('hold-1')).toBe(2);
      expect(deductCredits).toHaveBeenCalledTimes(1);
    });

    it('replays a committed async settlement receipt without charging again', async () => {
      const { hold } = await reserve();
      expect(await settleHeldCredits(hold!, 2, ledger, { ...context, throwOnUnconfirmed: true })).toBe(2);
      userIncrement.mockClear();
      deductCredits.mockClear();

      expect(await settleHeldCredits(hold!, 2, ledger, { ...context, throwOnUnconfirmed: true })).toBe(2);
      expect(userIncrement).not.toHaveBeenCalled();
      expect(deductCredits).not.toHaveBeenCalled();
    });

    it('settles a hold persisted before pending rows existed directly', async () => {
      const { hold } = await reserve();
      const { pendingHoldId: _pendingHoldId, ...legacy } = hold!;
      userIncrement.mockClear();

      expect(await settleHeldCredits(legacy, 2, ledger, context)).toBe(2);

      expect(markSettled).not.toHaveBeenCalled();
      expect(userIncrement).toHaveBeenCalledExactlyOnceWith('u1', 1);
      expect(deductCredits).toHaveBeenCalledTimes(1);
    });
  });
});
