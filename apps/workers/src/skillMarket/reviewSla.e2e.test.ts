import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

// Org lookup is the only external input to reviewer selection; everything else runs against a real mongod.
const orgs = vi.hoisted(() => ({
  broken: 'org-broken',
  info: new Map<
    string,
    { name?: string; userId?: string; adminUserIds?: string[]; users?: { userId: string; permissions: string[] }[] }
  >(),
}));
vi.mock('@bike4mind/database/infra', async importOriginal => ({
  ...(await importOriginal<object>()),
  organizationRepository: {
    findById: async (id: string) => {
      if (id === orgs.broken) throw new Error('org lookup down');
      return orgs.info.get(id) ?? { name: 'Acme' };
    },
  },
}));

import { Inbox, SkillListing, SkillListingVersion, User } from '@bike4mind/database';
import type { ISkillListing } from '@bike4mind/common';
import { MAX_SLA_REMINDERS, runSkillMarketReviewSla } from './reviewSla';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let mongoServer: MongoMemoryServer;
beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await Promise.all([SkillListing.ensureIndexes(), SkillListingVersion.ensureIndexes()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});
beforeEach(async () => {
  orgs.info.clear();
  await Promise.all(
    ['skill_listings', 'skill_listing_versions', 'inboxes', 'users'].map(c =>
      mongoose.connection.db!.collection(c).deleteMany({})
    )
  );
});

const AUTHOR = 'author-1';
const ORG = 'org-1';
const OVERDUE = () => new Date(Date.now() + 73 * 60 * 60 * 1000);

/**
 * A listing with one version held for human review (scan passed, review pending), the state
 * submitListingVersion leaves a high-risk-tool skill in.
 */
async function held(name: string, visibility: ISkillListing['visibility'], organizationId?: string) {
  const listing = await SkillListing.create({
    sourceSkillId: `skill-${name}`,
    authorUserId: AUTHOR,
    visibility,
    ...(organizationId ? { organizationId } : {}),
    tags: ['writing'],
    name,
    description: 'Formats text',
    status: 'in_review',
  });
  const version = await SkillListingVersion.create({
    listingId: String(listing._id),
    version: 1,
    snapshot: { name, description: 'Formats text', body: 'Fetch and summarize.' },
    contentHash: `hash-${name}`,
    scanStatus: 'passed',
    reviewStatus: 'pending',
  });
  await SkillListing.updateOne({ _id: listing._id }, { $set: { pendingVersionId: String(version._id) } });
  return { listing: { id: String(listing._id) }, version: { id: String(version._id) } };
}

describe('Skill Market review SLA (real mongod)', () => {
  it('SLA reminders: nudge author and org reviewers once per day, never approve', async () => {
    orgs.info.set(ORG, {
      name: 'Acme',
      userId: 'org-owner',
      adminUserIds: ['org-mgr'],
      users: [{ userId: 'org-mgr', permissions: ['read'] }],
    });
    const { listing, version } = await held('fetcher', 'organization', ORG);
    const later = OVERDUE();
    const before = await Inbox.countDocuments({});
    const authorBefore = await Inbox.countDocuments({ receiverId: AUTHOR });
    expect(await runSkillMarketReviewSla(later)).toEqual({ reminded: 1 });
    expect(await runSkillMarketReviewSla(later)).toEqual({ reminded: 0 });
    // One reminder to the author, one each to the org's owner and manager.
    expect(await Inbox.countDocuments({ receiverId: AUTHOR })).toBe(authorBefore + 1);
    expect(await Inbox.countDocuments({ receiverId: 'org-owner' })).toBe(1);
    expect(await Inbox.countDocuments({ receiverId: 'org-mgr' })).toBe(1);
    expect(await Inbox.countDocuments({})).toBe(before + 3);
    // Sent by the system, not shown as coming from the recipient themselves.
    expect((await Inbox.findOne({ receiverId: AUTHOR }).sort({ _id: -1 }))!.userId).toBe('SYSTEM');
    expect((await SkillListingVersion.findById(version.id))!.reviewStatus).toBe('pending');
    expect((await SkillListing.findById(listing.id))!.currentApprovedVersionId).toBeNull();
  });

  it('SLA reminders: nudge super-admins for a held Public version, never approve it', async () => {
    const admin = await User.create({ username: 'super-admin', name: 'Super Admin', isAdmin: true });
    const { version } = await held('fetcher', 'public');
    expect(await runSkillMarketReviewSla(OVERDUE())).toEqual({ reminded: 1 });
    expect(await Inbox.countDocuments({ receiverId: String(admin._id) })).toBe(1);
    expect((await SkillListingVersion.findById(version.id))!.reviewStatus).toBe('pending');
  });

  it('SLA reminders: retire an orphaned pending version and notify nobody', async () => {
    const missingListingId = new mongoose.Types.ObjectId().toString();
    const orphan = await SkillListingVersion.create({
      listingId: missingListingId,
      version: 1,
      snapshot: { name: 'orphan', description: 'd', body: 'b' },
      contentHash: 'orphan-hash',
      scanStatus: 'passed',
      reviewStatus: 'pending',
    });
    await SkillListingVersion.updateOne(
      { _id: orphan._id },
      { $set: { createdAt: new Date(Date.now() - 100 * 60 * 60 * 1000) } }
    );
    expect(await runSkillMarketReviewSla(OVERDUE())).toEqual({ reminded: 0 });
    expect((await SkillListingVersion.findById(orphan._id))!.reviewStatus).toBe('superseded');
    expect(await Inbox.countDocuments({})).toBe(0);
  });

  it('SLA reminders: never retire the version the listing is currently serving', async () => {
    const listing = await SkillListing.create({
      sourceSkillId: 'skill-x',
      authorUserId: AUTHOR,
      visibility: 'unlisted',
      name: 'live skill',
      description: 'd',
      status: 'approved',
    });
    const version = await SkillListingVersion.create({
      listingId: String(listing._id),
      version: 1,
      snapshot: { name: 'live skill', description: 'd', body: 'b' },
      contentHash: 'live-hash',
      scanStatus: 'passed',
      reviewStatus: 'pending',
    });
    await SkillListingVersion.updateOne(
      { _id: version._id },
      { $set: { createdAt: new Date(Date.now() - 100 * 60 * 60 * 1000) } }
    );
    await SkillListing.updateOne(
      { _id: listing._id },
      { $set: { currentApprovedVersionId: String(version._id), currentVersion: 1 } }
    );
    expect(await runSkillMarketReviewSla(OVERDUE())).toEqual({ reminded: 0 });
    expect((await SkillListingVersion.findById(version._id))!.reviewStatus).toBe('pending');
  });

  it('SLA reminders: stop after the cap, and one failing version does not stop the batch', async () => {
    await held('broken-org', 'organization', orgs.broken);
    const { version } = await held('public-one', 'public');
    await User.create({ username: 'super-admin', name: 'Super Admin', isAdmin: true });

    const day = 24 * 60 * 60 * 1000;
    const start = Date.now() + 73 * 60 * 60 * 1000;
    const runs = [];
    for (let i = 0; i <= MAX_SLA_REMINDERS; i++) runs.push(await runSkillMarketReviewSla(new Date(start + i * day)));
    // The broken-org version throws every run; the Public one is reminded up to the cap, then left alone.
    expect(runs.map(r => r.reminded)).toEqual([...Array(MAX_SLA_REMINDERS).fill(1), 0]);
    const stored = (await SkillListingVersion.findById(version.id))!;
    expect(stored.reminderCount).toBe(MAX_SLA_REMINDERS);
    expect(stored.reviewStatus).toBe('pending');
  });
});
