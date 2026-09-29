import { CreditHolderType } from '@bike4mind/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deductCredits, userFindById, orgFindById, userIncrement, orgIncrement } = vi.hoisted(() => ({
  deductCredits: vi.fn(),
  userFindById: vi.fn(),
  orgFindById: vi.fn(),
  userIncrement: vi.fn(),
  orgIncrement: vi.fn(),
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

import { reserveRequestCredits, type CreditLedgerEntry } from './reserveRequestCredits';

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
});
