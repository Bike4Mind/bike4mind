import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SkillListing, SkillListingVersion } from '@bike4mind/database';
import { loadVersionQueue } from './reviewQueue';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  await Promise.all([SkillListing.deleteMany({}), SkillListingVersion.deleteMany({})]);
});

const ORG = 'org-1';
const T0 = new Date('2026-01-01T00:00:00.000Z');

async function listing(visibility: 'organization' | 'public', organizationId?: string) {
  return SkillListing.create({
    sourceSkillId: `skill-${Math.random()}`,
    authorUserId: 'author-1',
    visibility,
    ...(organizationId ? { organizationId } : {}),
    name: 'formatter',
    description: 'Formats text',
  });
}

/** A held version; `point` makes it the listing's pending pointer (the only decidable kind). */
async function held(l: { _id: unknown }, version: number, createdAt: Date, point = true) {
  const v = await SkillListingVersion.create({
    listingId: String(l._id),
    version,
    snapshot: { name: 'formatter', description: 'Formats text', body: `v${version}` },
    contentHash: `hash-${Math.random()}`,
    scanStatus: 'passed',
    reviewStatus: 'pending',
  });
  // createdAt is set by timestamps on create, so pin it afterwards.
  await SkillListingVersion.collection.updateOne({ _id: v._id }, { $set: { createdAt } });
  if (point) await SkillListing.updateOne({ _id: l._id }, { $set: { pendingVersionId: String(v._id) } });
  return String(v._id);
}

const orgAdmin = { id: 'reviewer' };
const ids = (rows: { version: { _id: unknown } }[]) => rows.map(r => String(r.version._id));

describe('loadVersionQueue (real mongod)', () => {
  it('pages the pending queue oldest first, breaking createdAt ties by _id', async () => {
    const a = await held(await listing('organization', ORG), 1, T0);
    const b = await held(await listing('organization', ORG), 1, T0);
    const c = await held(await listing('organization', ORG), 1, new Date(T0.getTime() + 1000));
    const [first, second] = [a, b].sort();

    const p1 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 1 });
    expect(ids(p1.rows)).toEqual([first]);
    expect(p1.next).toEqual({ at: T0, id: first });

    const p2 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 2, after: p1.next! });
    expect(ids(p2.rows)).toEqual([second, c]);
    expect(p2.next).toEqual({ at: new Date(T0.getTime() + 1000), id: c });
  });

  it('skips a pending row the pointer never reached, but still advances past it', async () => {
    const l = await listing('organization', ORG);
    const orphan = await held(l, 1, T0, false);
    const pointed = await held(l, 2, new Date(T0.getTime() + 1000));

    const p1 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 1 });
    expect(p1.rows).toEqual([]);
    expect(p1.next).toEqual({ at: T0, id: orphan });

    const p2 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 1, after: p1.next! });
    expect(ids(p2.rows)).toEqual([pointed]);
    expect(p2.rows[0].canDecide).toBe(true);
  });

  it("scopes an org admin to their orgs' Organization listings; a super-admin sees all", async () => {
    const mine = await held(await listing('organization', ORG), 1, T0);
    const other = await held(await listing('organization', 'org-2'), 1, T0);
    const pub = await held(await listing('public'), 1, T0);

    expect(ids((await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 10 })).rows)).toEqual([mine]);
    const all = await loadVersionQueue({ id: 'admin', isAdmin: true }, [], { filter: 'pending', limit: 10 });
    expect(ids(all.rows).sort()).toEqual([mine, other, pub].sort());
  });

  it('links the approved version a held one would replace, never the row itself', async () => {
    const fresh = await held(await listing('organization', ORG), 1, T0);
    const l = await listing('organization', ORG);
    const live = await held(l, 1, T0, false);
    const next = await held(l, 2, new Date(T0.getTime() + 1000));
    await SkillListing.updateOne({ _id: l._id }, { $set: { currentApprovedVersionId: live } });
    const self = await listing('organization', ORG);
    const own = await held(self, 1, new Date(T0.getTime() + 2000));
    await SkillListing.updateOne({ _id: self._id }, { $set: { currentApprovedVersionId: own } });

    const { rows } = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 10 });
    const prevOf = (id: string) => rows.find(r => String(r.version._id) === id)?.previous;
    expect(prevOf(fresh)).toBeNull();
    expect(prevOf(next)).toMatchObject({ id: live, version: 1 });
    expect(prevOf(own)).toBeNull();
  });

  it('audits sampled approvals regardless of the pending pointer, but never by their author', async () => {
    const l = await listing('organization', ORG);
    const sampled = await held(l, 1, T0, false);
    const unsampled = await held(l, 2, new Date(T0.getTime() + 1000), false);
    const audited = await held(l, 3, new Date(T0.getTime() + 2000), false);
    await SkillListingVersion.updateOne(
      { _id: sampled },
      { $set: { reviewStatus: 'auto_approved', auditSample: true } }
    );
    await SkillListingVersion.updateOne({ _id: unsampled }, { $set: { reviewStatus: 'approved' } });
    await SkillListingVersion.updateOne(
      { _id: audited },
      { $set: { reviewStatus: 'approved', auditSample: true, auditedAt: T0 } }
    );

    const byReviewer = await loadVersionQueue(orgAdmin, [ORG], { filter: 'audit', limit: 10 });
    expect(ids(byReviewer.rows)).toEqual([sampled]);
    expect(byReviewer.rows[0].canDecide).toBe(true);
    const byAuthor = await loadVersionQueue({ id: 'author-1' }, [ORG], { filter: 'audit', limit: 10 });
    expect(byAuthor.rows[0].canDecide).toBe(false);
  });
});
