import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { Inbox, Organization, OrgAlertNotificationModel, User, inboxRepository, mongoose } from '@bike4mind/database';
import {
  createMongoReplSet,
  MONGO_TEST_TIMEOUT_MS,
  settleAutoIndexBuilds,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { clearMemberCapAlertCache, evaluateMemberCap } from './evaluateMemberCap';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('../utils/eventBus', () => ({ EmailEvents: { Send: { publish } } }));

const orgId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const memberId = new mongoose.Types.ObjectId().toHexString();
const NOV = new Date('2026-11-15T00:00:00Z');
const periodStart = new Date('2026-11-01T00:00:00Z');

let mongoServer: MongoMemoryReplSet;

beforeAll(async () => {
  process.env.APP_URL = 'https://app.example.com';
  mongoServer = await createMongoReplSet();
  await mongoose.connect(mongoServer.getUri());
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

const seed = async (org: Record<string, unknown>) =>
  Organization.collection.insertOne({
    _id: orgId,
    name: 'Acme',
    personal: false,
    userId: ownerId.toHexString(),
    maxCreditsPerMember: 100,
    ...org,
  });

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await OrgAlertNotificationModel.ensureIndexes();
  await Inbox.createCollection();
  clearMemberCapAlertCache();
  publish.mockReset();
  await User.collection.insertOne({ _id: ownerId, email: 'owner@example.com' });
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(memberId) });
});

const check = (refused?: boolean, userId = memberId) =>
  evaluateMemberCap({ organizationId: orgId.toHexString(), userId, refused }, NOV);
const claims = () => OrgAlertNotificationModel.find({ organizationId: orgId.toHexString(), kind: 'member_cap' }).lean();
const member = (usedCredits: number, maxCredits?: number | null) => ({
  id: memberId,
  name: 'Sam',
  usedCredits,
  periodStart,
  ...(maxCredits !== undefined ? { maxCredits } : {}),
});

describe('evaluateMemberCap', () => {
  it('alerts once per period when a member reaches the cap', async () => {
    await seed({ userDetails: [member(100)] });

    await check();
    clearMemberCapAlertCache();
    await check();

    expect((await claims()).map(c => [c.scope, c.periodKey, c.subjectUserId])).toEqual([
      [`user:${memberId}`, '2026-11', memberId],
    ]);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].body).toContain('Sam has used 100 of their 100 credit monthly limit');

    const [entry] = await inboxRepository.findByReceiverId(ownerId.toHexString());
    expect(entry.message).toContain('A member has used 100 of their 100 credit monthly limit');
    expect(entry.message).not.toContain('Sam');
  });

  it('stays quiet below the cap', async () => {
    await seed({ userDetails: [member(99)] });

    await check();

    expect(await claims()).toHaveLength(0);
  });

  it('alerts on a cap refusal even below the cap', async () => {
    await seed({ userDetails: [member(99)] });

    await check(true);

    expect(await claims()).toHaveLength(1);
    expect(publish.mock.calls[0][0].subject).toContain('request exceeds remaining credit limit');
    expect(publish.mock.calls[0][0].body).toContain('smaller requests may still fit');
    expect(publish.mock.calls[0][0].body).not.toContain('blocked until');
  });

  it('falls back to the org default when the member override is null', async () => {
    await seed({ userDetails: [member(100, null)] });

    await check();

    expect(await claims()).toHaveLength(1);
  });

  it('honours a member override above the org default', async () => {
    await seed({ userDetails: [member(100, 500)] });

    await check();

    expect(await claims()).toHaveLength(0);
  });

  it('ignores an uncapped org and the service account', async () => {
    await seed({ maxCreditsPerMember: null, serviceAccountUserId: 'svc', userDetails: [member(1000)] });

    await check(true);
    await check(true, 'svc');

    expect(await claims()).toHaveLength(0);
  });

  it('skips the org read for an uncapped member within the recheck window', async () => {
    await seed({ maxCreditsPerMember: null, userDetails: [member(1000)] });
    const findById = vi.spyOn(Organization, 'findById');

    await check();
    await check();

    expect(findById).toHaveBeenCalledOnce();
    findById.mockRestore();
  });

  it('rechecks an under-cap member on the next debit', async () => {
    await seed({ userDetails: [member(99)] });

    await check();
    await Organization.collection.updateOne({ _id: orgId }, { $set: { 'userDetails.0.usedCredits': 100 } });
    await check();

    expect(await claims()).toHaveLength(1);
  });
});
