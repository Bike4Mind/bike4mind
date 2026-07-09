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
  creditLotRepository: {
    findByOwner: vi.fn(async (ownerId: string, ownerType: CreditHolderType) =>
      fakeLots
        .filter(l => l.ownerId === ownerId && l.ownerType === ownerType)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
    ),
    update: vi.fn(async ({ id, consumedAssigned }: { id: string; consumedAssigned: number }) => {
      const lot = fakeLots.find(l => l.id === id);
      if (lot) lot.consumedAssigned = consumedAssigned;
      return lot ?? null;
    }),
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

// Imports after mocks
import { processHolder } from './creditLotSweep';

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
