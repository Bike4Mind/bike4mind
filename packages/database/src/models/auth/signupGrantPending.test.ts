import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  PENDING_FREE_CREDITS_TAG,
  signupGrantDripOpen,
  signupGrantDripRemaining,
  signupGrantRemaining,
  type SignupGrant,
} from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { User } from './UserModel';
import { buildListPendingPipeline, signupGrantPendingRepository } from './signupGrantPending';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;

const DRIP_CAP = 500;
const oid = (n: number) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
const grant = (over: Partial<SignupGrant> = {}) => ({
  stage: 'signup',
  signupCredits: 100,
  unlockCredits: 200,
  creditsReleased: 100,
  ...over,
});
const heldAt = new Date('2026-01-01T00:00:00Z');

// Raw inserts so fixtures can carry shapes the schema would coerce away (non-integer dripCredits).
const seed: Array<Record<string, unknown> & { _id: mongoose.Types.ObjectId; key: string }> = [
  {
    key: 'heldNoGrant',
    _id: oid(1),
    signupGrantHeldReason: 'budget_exhausted',
    signupGrantHeldAt: heldAt,
    pendingCreditGrant: 50,
    tags: [PENDING_FREE_CREDITS_TAG],
  },
  {
    key: 'heldRisk',
    _id: oid(2),
    signupGrantHeldReason: 'risk_review',
    tags: [PENDING_FREE_CREDITS_TAG],
    signupGrant: grant({ creditsReleased: 0 }),
  },
  { key: 'dripping', _id: oid(3), signupGrant: grant({ creditsReleased: 150, dripCredits: 50 }) },
  {
    key: 'fullyDripped',
    _id: oid(4),
    signupGrant: grant({ stage: 'unlocked', unlockedBy: 'verification', creditsReleased: 300 }),
  },
  { key: 'blocked', _id: oid(5), signupGrant: grant({ blocked: { at: heldAt } }) },
  { key: 'package', _id: oid(6), grantPackageId: 'pkg-1', signupGrant: grant({ creditsReleased: 250 }) },
  {
    key: 'forfeited',
    _id: oid(7),
    signupGrant: grant({ unlockForfeited: { cause: 'payment_refunded', at: heldAt } } as Partial<SignupGrant>),
  },
  {
    key: 'overCap',
    _id: oid(8),
    signupGrant: grant({
      stage: 'unlocked',
      unlockedBy: 'activity_drip',
      unlockCredits: 900,
      dripCredits: 900,
      creditsReleased: 600,
    }),
  },
  { key: 'fractionalDrip', _id: oid(9), signupGrant: grant({ dripCredits: 12.5, creditsReleased: 112 }) },
  { key: 'noGrant', _id: oid(10) },
  { key: 'pendingEmail', _id: oid(11), signupGrant: grant({ stage: 'pending_email', creditsReleased: 0 }) },
  { key: 'heldNoTag', _id: oid(12), signupGrantHeldReason: 'budget_exhausted', tags: [] },
];
const idOf = (key: string) => String(seed.find(s => s.key === key)!._id);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await User.createIndexes();
  await User.collection.insertMany(
    seed.map(({ key, ...doc }) => ({ ...doc, email: `${key}@example.com`, username: key, createdAt: heldAt }))
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

const listAll = async (input: Partial<Parameters<typeof signupGrantPendingRepository.listPending>[0]> = {}) =>
  (await signupGrantPendingRepository.listPending({ dripCap: DRIP_CAP, sort: 'oldest', limit: 100, ...input })).rows;

describe('signupGrantPendingRepository.listPending', () => {
  it('computes remaining and dripRemaining exactly as the shared helpers do, for every seeded grant', async () => {
    const rows = new Map((await listAll()).map(r => [r.id, r]));
    for (const s of seed) {
      const g = s.signupGrant as SignupGrant | undefined;
      const remaining = g ? signupGrantRemaining(g, DRIP_CAP) : 0;
      const dripRemaining = g && signupGrantDripOpen(g) ? signupGrantDripRemaining(g, DRIP_CAP) : 0;
      const row = rows.get(String(s._id));
      if (!row) {
        expect({ key: s.key, remaining }).toEqual({ key: s.key, remaining: 0 });
        continue;
      }
      expect({ key: s.key, remaining: row.remaining, dripRemaining: row.dripRemaining }).toEqual({
        key: s.key,
        remaining,
        dripRemaining,
      });
    }
  });

  it('includes held, dripping and blocked accounts and leaves out fully paid, grantless and untagged holds', async () => {
    const ids = (await listAll()).map(r => r.id);
    for (const key of [
      'heldNoGrant',
      'heldRisk',
      'dripping',
      'blocked',
      'package',
      'forfeited',
      'overCap',
      'fractionalDrip',
      'pendingEmail',
    ]) {
      expect(ids).toContain(idOf(key));
    }
    for (const key of ['fullyDripped', 'noGrant', 'heldNoTag']) expect(ids).not.toContain(idOf(key));
  });

  it('reports a grantless held tranche with its hold details and zero remaining', async () => {
    const row = (await listAll()).find(r => r.id === idOf('heldNoGrant'))!;
    expect(row).toMatchObject({
      status: 'held',
      source: null,
      stage: null,
      heldReason: 'budget_exhausted',
      heldCredits: 50,
      remaining: 0,
    });
    expect(row.heldAt?.toISOString()).toBe(heldAt.toISOString());
  });

  it('filters by status, held reason and source', async () => {
    const ids = async (input: Parameters<typeof listAll>[0]) => (await listAll(input)).map(r => r.id).sort();
    expect(await ids({ status: 'blocked' })).toEqual([idOf('blocked')]);
    expect(await ids({ status: 'held' })).toEqual([idOf('heldNoGrant'), idOf('heldRisk')].sort());
    expect(await ids({ heldReason: 'risk_review' })).toEqual([idOf('heldRisk')]);
    expect(await ids({ source: 'package' })).toEqual([idOf('package')]);
    const defaults = await ids({ source: 'default' });
    expect(defaults).not.toContain(idOf('package'));
    expect(defaults).not.toContain(idOf('heldNoGrant'));
    expect(defaults).toContain(idOf('dripping'));
    expect((await listAll({ status: 'dripping' })).every(r => r.status === 'dripping')).toBe(true);
    expect(await ids({ status: 'locked' })).toEqual([idOf('forfeited'), idOf('pendingEmail')].sort());
    expect(await ids({ status: 'held', heldReason: 'budget_exhausted' })).toEqual([idOf('heldNoGrant')]);
    expect(await ids({ status: 'dripping', source: 'package' })).toEqual([idOf('package')]);
  });

  it('labels a row dripping only while its drip can still pay, and locked otherwise', async () => {
    const statusOf = new Map((await listAll()).map(r => [r.id, r.status]));
    for (const s of seed) {
      const g = s.signupGrant as SignupGrant | undefined;
      if (!statusOf.has(String(s._id)) || s.key.startsWith('held') || s.key === 'blocked') continue;
      expect({ key: s.key, status: statusOf.get(String(s._id)) }).toEqual({
        key: s.key,
        status: g && signupGrantDripOpen(g) ? 'dripping' : 'locked',
      });
    }
    expect(statusOf.get(idOf('forfeited'))).toBe('locked');
    expect(statusOf.get(idOf('pendingEmail'))).toBe('locked');
    expect(statusOf.get(idOf('blocked'))).toBe('blocked');
  });

  it('sorts oldest-first by id, or by remaining descending with id as the tiebreak', async () => {
    const oldest = (await listAll()).map(r => r.id);
    expect(oldest).toEqual([...oldest].sort());
    const byRemaining = await listAll({ sort: 'remaining' });
    for (let i = 1; i < byRemaining.length; i++) {
      const [a, b] = [byRemaining[i - 1], byRemaining[i]];
      expect(a.remaining > b.remaining || (a.remaining === b.remaining && a.id < b.id)).toBe(true);
    }
  });

  it.each(['oldest', 'remaining'] as const)(
    'pages with a cursor into disjoint pages covering the whole list (%s)',
    async sort => {
      const all = (await listAll({ sort })).map(r => r.id);
      const seen: string[] = [];
      let cursor: Awaited<ReturnType<typeof signupGrantPendingRepository.listPending>>['next'] = null;
      do {
        const page = await signupGrantPendingRepository.listPending({
          dripCap: DRIP_CAP,
          sort,
          limit: 4,
          cursor: cursor ?? undefined,
        });
        seen.push(...page.rows.map(r => r.id));
        cursor = page.next;
      } while (cursor);
      expect(seen).toEqual(all);
      expect(new Set(seen).size).toBe(seen.length);
    }
  );

  it('returns no next cursor on the last page', async () => {
    const page = await signupGrantPendingRepository.listPending({ dripCap: DRIP_CAP, sort: 'oldest', limit: 100 });
    expect(page.next).toBeNull();
  });

  it.each([
    { sort: 'oldest' as const },
    { sort: 'remaining' as const },
    { sort: 'remaining' as const, cursor: { id: idOf('dripping'), remaining: 200 } },
  ])('serves the shipped list aggregate from both partial indexes (%o)', async input => {
    const pipeline = buildListPendingPipeline({ dripCap: DRIP_CAP, limit: 25, ...input });
    const explain = await User.aggregate(pipeline).explain('queryPlanner');
    // Unsharded explain puts the pushed-down $match plan under the first stage's $cursor, or top level.
    const planner = JSON.stringify(
      (explain as { stages?: Array<{ $cursor?: { queryPlanner?: unknown } }>; queryPlanner?: unknown }).stages?.[0]
        ?.$cursor?.queryPlanner ?? (explain as { queryPlanner?: unknown }).queryPlanner
    );
    const winning = JSON.stringify(JSON.parse(planner).winningPlan);
    expect(winning).toContain('user_signupGrant_stage');
    expect(winning).toContain('user_signupGrantHeldReason');
    expect(winning).not.toContain('COLLSCAN');
  });
});

describe('signupGrantPendingRepository.summarizePending', () => {
  it('totals remaining and drip remaining over listed rows that can still pay, leaving out blocked and forfeited', async () => {
    const unpaid = new Set([idOf('blocked'), idOf('forfeited')]);
    const all = await listAll();
    const rows = all.filter(r => !unpaid.has(r.id));
    expect(all.length - rows.length).toBe(2);
    expect(all.filter(r => unpaid.has(r.id)).every(r => r.remaining > 0)).toBe(true);
    const summary = await signupGrantPendingRepository.summarizePending({ dripCap: DRIP_CAP });
    expect(summary).toEqual({
      accountsWithRemaining: rows.filter(r => r.remaining > 0).length,
      totalRemaining: rows.reduce((sum, r) => sum + r.remaining, 0),
      totalDripRemaining: rows.reduce((sum, r) => sum + r.dripRemaining, 0),
    });
    expect(summary.accountsWithRemaining).toBeGreaterThan(0);
  });

  it('counts the held queue as the rows the list labels held, of either reason', async () => {
    const held = (await listAll({ status: 'held' })).map(r => r.id);
    const queue = await signupGrantPendingRepository.heldQueue();
    expect(queue.held).toBe(held.length);
    expect(held).toEqual(expect.arrayContaining([idOf('heldNoGrant'), idOf('heldRisk')]));
    expect(queue.oldestHeldAt?.toISOString()).toBe(heldAt.toISOString());
  });
});
