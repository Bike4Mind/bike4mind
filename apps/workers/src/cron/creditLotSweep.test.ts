import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CreditHolderType } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

interface FakeLot {
  id: string;
  ownerId: string;
  ownerType: CreditHolderType;
  source: string;
  amount: number;
  consumedAssigned: number;
  expiresAt: Date;
  settledAt?: Date;
}

const { fakeLots, userState, orgState, agentState, txRows } = vi.hoisted(() => ({
  fakeLots: [] as FakeLot[],
  userState: { currentCredits: 0 },
  orgState: { currentCredits: 0 },
  agentState: { currentCredits: 0 },
  txRows: [] as unknown[],
}));

function makeHolderRepo(state: { currentCredits: number }) {
  return {
    findById: vi.fn(async () => ({ currentCredits: state.currentCredits })),
    incrementCredits: vi.fn(async (_id: string, delta: number) => {
      state.currentCredits += delta;
      return { currentCredits: state.currentCredits };
    }),
  };
}

vi.mock('@bike4mind/database', () => ({
  connectDB: vi.fn(),
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  creditLotRepository: {
    findByOwner: vi.fn(async (ownerId: string, ownerType: CreditHolderType) =>
      fakeLots
        .filter(l => l.ownerId === ownerId && l.ownerType === ownerType)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
    ),
    update: vi.fn(
      async ({ id, consumedAssigned, settledAt }: { id: string; consumedAssigned: number; settledAt?: Date }) => {
        const lot = fakeLots.find(l => l.id === id);
        if (lot) {
          lot.consumedAssigned = consumedAssigned;
          if (settledAt) lot.settledAt = settledAt;
        }
        return lot ?? null;
      }
    ),
  },
  creditTransactionRepository: {
    createTransaction: vi.fn(async (type: string, data: Record<string, unknown>) => {
      const row = { id: `tx${txRows.length + 1}`, type, ...data };
      txRows.push(row);
      return row;
    }),
  },
  userRepository: makeHolderRepo(userState),
  organizationRepository: makeHolderRepo(orgState),
  agentRepository: makeHolderRepo(agentState),
  CreditLot: { aggregate: vi.fn() },
}));

vi.mock('@server/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://fixture/%STAGE%' } }));
vi.mock('sst', () => ({ Resource: { App: { stage: 'fixture' } } }));

// Imports after mocks
import { handler, processHolder, runCreditLotSweep } from './creditLotSweep';
import { CreditLot, creditLotRepository } from '@bike4mind/database';

const OWNER_ID = 'user1';
const NOW = new Date('2026-06-01T00:00:00.000Z');

function addLot(overrides: Partial<FakeLot>) {
  const lot: FakeLot = {
    id: `lot${fakeLots.length + 1}`,
    ownerId: OWNER_ID,
    ownerType: CreditHolderType.User,
    source: 'pack',
    amount: 100,
    consumedAssigned: 0,
    expiresAt: new Date('2027-01-01T00:00:00.000Z'),
    ...overrides,
  };
  fakeLots.push(lot);
  return lot;
}

describe('creditLotSweep - processHolder', () => {
  const logger = new Logger();

  beforeEach(() => {
    fakeLots.length = 0;
    txRows.length = 0;
    userState.currentCredits = 0;
    orgState.currentCredits = 0;
    agentState.currentCredits = 0;
    vi.clearAllMocks();
  });

  it('assigns consumption soonest-expiry-first across multiple lots, with partial fills', async () => {
    userState.currentCredits = 150;
    // Total granted 300, currentCredits 150 -> consumption = 150
    const soon = addLot({ amount: 100, expiresAt: new Date('2026-07-01T00:00:00.000Z') });
    const mid = addLot({ amount: 100, expiresAt: new Date('2026-08-01T00:00:00.000Z') });
    const later = addLot({ amount: 100, expiresAt: new Date('2026-09-01T00:00:00.000Z') });

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    expect(soon.consumedAssigned).toBe(100); // fully consumed first
    expect(mid.consumedAssigned).toBe(50); // partial fill
    expect(later.consumedAssigned).toBe(0); // untouched
    // None are stale yet - no expiry decrement, no ledger row.
    expect(txRows).toHaveLength(0);
    expect(userState.currentCredits).toBe(150);
  });

  it('expires a stale lot: decrements currentCredits and writes a credit_expiry ledger row', async () => {
    userState.currentCredits = 100;
    // Total granted 100 == currentCredits -> consumption = 0, so the stale lot's full
    // amount is unassigned ("remaining") and gets expired.
    const stale = addLot({ amount: 100, expiresAt: new Date('2026-01-01T00:00:00.000Z') });

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    expect(stale.consumedAssigned).toBe(100);
    expect(userState.currentCredits).toBe(0);
    expect(txRows).toHaveLength(1);
    expect(txRows[0]).toMatchObject({ type: 'generic_deduct', reason: 'credit_expiry', credits: -100 });
  });

  it('clamps the expiry decrement at the available balance (never drives currentCredits negative)', async () => {
    userState.currentCredits = 30;
    // Total granted 100, currentCredits 30 -> consumption = 70, fully assigned to this
    // one lot, leaving a 30 remainder - but only 30 credits exist to take.
    const stale = addLot({ amount: 100, expiresAt: new Date('2026-01-01T00:00:00.000Z') });

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    expect(userState.currentCredits).toBe(0); // clamped, never negative
    expect(stale.consumedAssigned).toBe(100); // still marked fully realized
    expect(txRows).toHaveLength(1);
    expect(txRows[0]).toMatchObject({ credits: -30 }); // only what was actually available
  });

  it('skips holders with currentCredits <= 0 entirely (no lot lookup, no writes)', async () => {
    userState.currentCredits = 0;
    addLot({ amount: 100, expiresAt: new Date('2026-01-01T00:00:00.000Z') });

    const result = await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    expect(result).toEqual({ expiredLots: 0, expiredCredits: 0 });
    expect(txRows).toHaveLength(0);
  });

  it('is idempotent: running twice in a row produces identical currentCredits/consumedAssigned and no duplicate ledger rows', async () => {
    userState.currentCredits = 100;
    const stale = addLot({ amount: 100, expiresAt: new Date('2026-01-01T00:00:00.000Z') });

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);
    const creditsAfterFirstRun = userState.currentCredits;
    const consumedAfterFirstRun = stale.consumedAssigned;
    const txCountAfterFirstRun = txRows.length;

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    expect(userState.currentCredits).toBe(creditsAfterFirstRun);
    expect(stale.consumedAssigned).toBe(consumedAfterFirstRun);
    expect(txRows).toHaveLength(txCountAfterFirstRun);
  });

  it.each([CreditHolderType.Organization, CreditHolderType.Agent])('expires lots owned by %s', async ownerType => {
    const state = ownerType === CreditHolderType.Organization ? orgState : agentState;
    state.currentCredits = 100;
    const lot = addLot({ ownerType, expiresAt: new Date('2000-01-01T00:00:00Z') });
    expect(await processHolder({ ownerId: OWNER_ID, ownerType }, NOW, logger)).toEqual({
      expiredLots: 1,
      expiredCredits: 100,
    });
    expect(state.currentCredits).toBe(0);
    expect(lot.consumedAssigned).toBe(100);
    expect(txRows).toEqual([expect.objectContaining({ ownerId: OWNER_ID, ownerType, credits: -100 })]);
  });

  it('retains a settled expiry after an absolute balance top-up', async () => {
    userState.currentCredits = 300;
    const stale = addLot({ amount: 100, expiresAt: new Date('2000-01-01T00:00:00Z') });
    expect(await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger)).toEqual({
      expiredLots: 1,
      expiredCredits: 100,
    });
    expect(await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger)).toEqual({
      expiredLots: 0,
      expiredCredits: 0,
    });
    expect(userState.currentCredits).toBe(200);
    expect(stale.consumedAssigned).toBe(100);
    expect(txRows).toHaveLength(1);
  });

  it.each([
    { consumedAssigned: -20, expiredCredits: 100, expiredLots: 1, balance: 0 },
    { consumedAssigned: 200, expiredCredits: 100, expiredLots: 1, balance: 0 },
  ])(
    'recalculates an unmarked stale assignment of $consumedAssigned',
    async ({ consumedAssigned, expiredCredits, expiredLots, balance }) => {
      userState.currentCredits = 100;
      const stale = addLot({ consumedAssigned, expiresAt: new Date('2000-01-01T00:00:00Z') });
      expect(await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger)).toEqual({
        expiredLots,
        expiredCredits,
      });
      expect(stale.consumedAssigned).toBe(100);
      expect(userState.currentCredits).toBe(balance);
    }
  );

  it('leaves non-stale lots alone even when fully assigned by consumption', async () => {
    userState.currentCredits = 0;
    // Won't be reached because currentCredits <= 0 skips entirely - use a small
    // positive balance instead so the assignment path runs but expiresAt is future.
    userState.currentCredits = 1;
    const future = addLot({ amount: 100, expiresAt: new Date('2027-01-01T00:00:00.000Z') });

    await processHolder({ ownerId: OWNER_ID, ownerType: CreditHolderType.User }, NOW, logger);

    // consumption = max(0, 100 - 1) = 99, fully assignable to the one lot.
    expect(future.consumedAssigned).toBe(99);
    expect(txRows).toHaveLength(0); // not stale - no expiry action
    expect(userState.currentCredits).toBe(1); // untouched
  });
});

describe('connection-independent credit lot sweep', () => {
  beforeEach(() => {
    fakeLots.length = 0;
    txRows.length = 0;
    userState.currentCredits = 100;
    vi.clearAllMocks();
  });

  it('continues after a failed holder and preserves the hosted summary', async () => {
    const holder = { ownerId: OWNER_ID, ownerType: CreditHolderType.User };
    addLot({ amount: 100, expiresAt: new Date('2000-01-01T00:00:00Z') });
    vi.mocked(CreditLot.aggregate)
      .mockResolvedValueOnce([{ _id: { ...holder, ownerId: 'failed-holder' } }, { _id: holder }])
      .mockResolvedValueOnce([]);
    vi.mocked(creditLotRepository.findByOwner).mockRejectedValueOnce(new Error('fixture read failure'));
    expect(await runCreditLotSweep(new Logger())).toEqual({
      holdersProcessed: 2,
      holdersFailed: 1,
      expiredLots: 1,
      expiredCredits: 100,
    });
    expect(userState.currentCredits).toBe(0);
    expect(txRows).toHaveLength(1);
  });

  it('preserves the hosted 200 envelope and exact summary keys', async () => {
    vi.mocked(CreditLot.aggregate).mockResolvedValueOnce([]);
    const response = await handler(
      undefined as never,
      {
        awsRequestId: 'fixture-request',
        functionName: 'fixture',
        functionVersion: 'fixture',
      } as import('aws-lambda').Context
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      holdersProcessed: 0,
      holdersFailed: 0,
      expiredLots: 0,
      expiredCredits: 0,
    });
  });

  it('keeps paging after a complete 500-holder batch', async () => {
    userState.currentCredits = 0;
    const holder = { ownerId: OWNER_ID, ownerType: CreditHolderType.User };
    vi.mocked(CreditLot.aggregate)
      .mockResolvedValueOnce(
        Array.from({ length: 500 }, (_, index) => ({
          _id: { ...holder, ownerId: `holder-${String(index).padStart(3, '0')}` },
        }))
      )
      .mockResolvedValueOnce([{ _id: { ...holder, ownerId: 'holder-500' } }])
      .mockResolvedValueOnce([]);
    expect(await runCreditLotSweep(new Logger())).toEqual({
      holdersProcessed: 501,
      holdersFailed: 0,
      expiredLots: 0,
      expiredCredits: 0,
    });
    expect(CreditLot.aggregate).toHaveBeenNthCalledWith(2, [
      { $group: { _id: { ownerId: '$ownerId', ownerType: '$ownerType' } } },
      { $sort: { '_id.ownerId': 1, '_id.ownerType': 1 } },
      { $skip: 500 },
      { $limit: 500 },
    ]);
    expect(txRows).toHaveLength(0);
  });
});
