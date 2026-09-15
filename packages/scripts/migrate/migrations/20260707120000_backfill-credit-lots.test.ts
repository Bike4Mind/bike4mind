import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB handle the migration reaches via mongoose.connection.db - mirrors
// 20260702010000_backfill-policy-acceptance-grandfather.test.ts.

interface Doc {
  _id: string;
  [key: string]: unknown;
}

function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, cond]) => {
    const val = doc[key];
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, unknown>;
      if ('$gt' in c) return (val as number) > (c.$gt as number);
      if ('$in' in c) return (c.$in as unknown[]).includes(val);
      return false;
    }
    return val === cond;
  });
}

class FakeCollection {
  constructor(public docs: Doc[] = []) {}

  find(filter: Record<string, unknown> = {}) {
    const filtered = this.docs.filter(d => matches(d, filter));
    return {
      sort: () => ({
        limit: () => ({
          toArray: async () => filtered,
        }),
      }),
      toArray: async () => filtered,
    };
  }

  async insertMany(docs: Doc[]) {
    this.docs.push(...docs);
    return { insertedCount: docs.length };
  }

  async deleteMany(filter: Record<string, unknown>) {
    const before = this.docs.length;
    this.docs = this.docs.filter(d => !matches(d, filter));
    return { deletedCount: before - this.docs.length };
  }
}

const usersCollection = new FakeCollection();
const organizationsCollection = new FakeCollection();
const agentsCollection = new FakeCollection();
const creditLotsCollection = new FakeCollection();

const mockCollection = vi.fn((name: string) => {
  switch (name) {
    case 'users':
      return usersCollection;
    case 'organizations':
      return organizationsCollection;
    case 'agents':
      return agentsCollection;
    case 'creditlots':
      return creditLotsCollection;
    default:
      throw new Error(`unexpected collection: ${name}`);
  }
});

vi.mock('@bike4mind/database', () => ({
  mongoose: {
    connection: {
      get db() {
        return { collection: mockCollection };
      },
    },
  },
}));

import migration from './20260707120000_backfill-credit-lots';

describe('backfill-credit-lots migration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usersCollection.docs = [];
    organizationsCollection.docs = [];
    agentsCollection.docs = [];
    creditLotsCollection.docs = [];
  });

  it('creates exactly one legacy lot per holder with currentCredits > 0', async () => {
    usersCollection.docs = [
      { _id: 'u1', currentCredits: 500 },
      { _id: 'u2', currentCredits: 0 }, // excluded - no credits
    ];
    organizationsCollection.docs = [{ _id: 'o1', currentCredits: 1200 }];
    agentsCollection.docs = [{ _id: 'a1', currentCredits: 50 }];

    await migration.up();

    expect(creditLotsCollection.docs).toHaveLength(3);
    const userLot = creditLotsCollection.docs.find(d => d.ownerId === 'u1');
    expect(userLot).toMatchObject({
      ownerId: 'u1',
      ownerType: 'User',
      source: 'legacy',
      amount: 500,
      consumedAssigned: 0,
    });
    expect(userLot?.expiresAt).toBeInstanceOf(Date);

    expect(creditLotsCollection.docs.find(d => d.ownerId === 'o1')).toMatchObject({
      ownerType: 'Organization',
      amount: 1200,
      source: 'legacy',
    });
    expect(creditLotsCollection.docs.find(d => d.ownerId === 'a1')).toMatchObject({
      ownerType: 'Agent',
      amount: 50,
      source: 'legacy',
    });
  });

  it('sets expiresAt to roughly 12 months out', async () => {
    usersCollection.docs = [{ _id: 'u1', currentCredits: 100 }];

    const before = Date.now();
    await migration.up();

    const lot = creditLotsCollection.docs[0];
    const expiresAt = lot.expiresAt as Date;
    const elevenMonthsMs = 11 * 30 * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - before).toBeGreaterThan(elevenMonthsMs);
  });

  it('is idempotent — re-running the migration does not double-backfill', async () => {
    usersCollection.docs = [{ _id: 'u1', currentCredits: 500 }];

    await migration.up();
    expect(creditLotsCollection.docs).toHaveLength(1);

    await migration.up();
    expect(creditLotsCollection.docs).toHaveLength(1);
  });

  it('skips holders with currentCredits <= 0', async () => {
    usersCollection.docs = [{ _id: 'u1', currentCredits: 0 }];

    await migration.up();

    expect(creditLotsCollection.docs).toHaveLength(0);
  });

  it('down() removes only legacy lots', async () => {
    creditLotsCollection.docs = [
      { _id: 'l1', ownerId: 'u1', source: 'legacy' },
      { _id: 'l2', ownerId: 'u2', source: 'pack' },
    ];

    await migration.down();

    expect(creditLotsCollection.docs).toEqual([{ _id: 'l2', ownerId: 'u2', source: 'pack' }]);
  });
});
