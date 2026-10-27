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

    const p1 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 2 });
    expect(ids(p1.rows)).toEqual([first, second]);
    expect(p1.next).toEqual({ at: T0, id: second });

    const p2 = await loadVersionQueue(orgAdmin, [ORG], { filter: 'pending', limit: 2, after: p1.next! });
    expect(ids(p2.rows)).toEqual([c]);
    expect(p2.next).toBeNull();
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
});
