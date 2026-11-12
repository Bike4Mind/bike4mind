/**
 * Real-Mongo check of the evaluation sets: a draw freezes labels and keeps linked accounts on one
 * split, the unflagged sample is frozen in the set, and drawing, labelling and running never write to
 * users, credits or usage.
 *
 * Consumes the built dist (`pnpm turbo:core:build`); integration lane only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  AbuseAssessmentModel,
  AbuseEvalSetModel,
  AdminAuditLogModel,
  CreditTransaction,
  ShadowDetectionModel,
  UsageEvent,
  User,
  abuseEvalSetRepository,
} from '@bike4mind/database';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../packages/database/src/__test__/createMongoServer';
import { drawEvalSet, runEvalSet, type EvalSetDeps } from './evalSets';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NOW = new Date('2026-11-06T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const ADMIN_ID = new mongoose.Types.ObjectId().toString();

const deps = (seed: string, detectionLimit = 2_000): EvalSetDeps => ({
  signupVerdicts: async () => new Map(),
  newSeed: () => seed,
  detectionLimit,
});

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await Promise.all(
    [
      User,
      ShadowDetectionModel,
      AbuseAssessmentModel,
      AdminAuditLogModel,
      UsageEvent,
      CreditTransaction,
      AbuseEvalSetModel,
    ].map(model => model.collection.deleteMany({}))
  );
});

async function seedUser(fields: Record<string, unknown>): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await User.collection.insertOne({
    _id,
    username: `user-${_id}`,
    email: `${_id}@example.test`,
    createdAt: daysAgo(3),
    ...fields,
  });
  return _id.toString();
}

async function seedDetection(
  userIds: string[],
  verdict: string | null,
  groupMembers: string[] = [],
  detectedAt = daysAgo(2),
  verdicts: Record<string, unknown>[] = []
): Promise<string> {
  const _id = new mongoose.Types.ObjectId();
  await ShadowDetectionModel.collection.insertOne({
    _id,
    detector: 'deviceLinkedToBlocked',
    policyVersion: 1,
    userIds,
    ...(groupMembers.length > 0 ? { group: { members: groupMembers.map(userId => ({ userId })) } } : {}),
    detectedAt,
    verdict,
    verdicts,
  });
  return _id.toString();
}

type Seeded = { farm: string[]; farmDetection: string; legitFlagged: string; sharedIpUnflagged: string };

async function seedWorld(): Promise<Seeded> {
  const farm = [
    await seedUser({ signupMeta: { ip: '203.0.113.7' } }),
    await seedUser({ signupMeta: { ip: '203.0.113.7' } }),
    await seedUser({}),
  ];
  const legitFlagged = await seedUser({});
  const farmDetection = await seedDetection(farm, 'confirmed_abuse');
  await seedDetection([legitFlagged], 'legitimate_human');
  await AbuseAssessmentModel.collection.insertOne({
    cacheKey: `seed-${farmDetection}`,
    detectionId: farmDetection,
    result: 'abuse',
    confidence: 0.9,
    decisionModel: 'jev-latest',
    assessedAt: daysAgo(1),
  });
  // Not named by any detection, but it signed up from the farm's network.
  const sharedIpUnflagged = await seedUser({ signupMeta: { ip: '203.0.113.7' } });
  for (let index = 0; index < 40; index += 1) await seedUser({ signupMeta: { ip: `198.51.100.${index}` } });
  await UsageEvent.collection.insertOne({
    userId: farm[0],
    source: 'chat',
    creditsCharged: 5,
    createdAt: daysAgo(2),
  });
  await CreditTransaction.collection.insertOne({ userId: farm[0], amount: -5, createdAt: daysAgo(2) });
  return { farm, farmDetection, legitFlagged, sharedIpUnflagged };
}

const request = { name: 'November', days: 30 as const, unflaggedSample: 500, heldOutShare: 0.5 };

describe('drawEvalSet', () => {
  it('freezes labels, links campaigns and puts each campaign on one split', async () => {
    const world = await seedWorld();
    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    expect(set.population).toEqual({ flagged: 4, unflagged: 41 });
    expect(set.examples).toHaveLength(45);
    const byUser = new Map(set.examples.map(example => [example.userId, example]));
    expect(byUser.get(world.farm[0])).toMatchObject({
      kind: 'flagged',
      frozenLabel: { label: 'abuse', source: 'adminVerdict' },
    });
    expect(byUser.get(world.legitFlagged)?.frozenLabel).toEqual({ label: 'legit', source: 'adminVerdict' });
    expect(byUser.get(world.sharedIpUnflagged)).toMatchObject({ kind: 'unflagged', frozenLabel: null });

    const campaignOfFarm = byUser.get(world.farm[0])?.campaignKey;
    for (const userId of [...world.farm, world.sharedIpUnflagged]) {
      expect(byUser.get(userId)?.campaignKey).toBe(campaignOfFarm);
    }
    const splitsByCampaign = new Map<string, Set<string>>();
    for (const example of set.examples) {
      splitsByCampaign.set(
        example.campaignKey,
        (splitsByCampaign.get(example.campaignKey) ?? new Set()).add(example.split)
      );
    }
    expect([...splitsByCampaign.values()].every(splits => splits.size === 1)).toBe(true);
    const userIds = new Set(set.examples.map(example => example.userId));
    expect(set.examples.some(example => userIds.has(example.campaignKey))).toBe(false);
  });

  it('freezes a sample of the requested size that excludes flagged accounts', async () => {
    const world = await seedWorld();
    const flagged = new Set([...world.farm, world.legitFlagged]);
    const id = await drawEvalSet({ ...request, unflaggedSample: 10 }, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    const unflagged = set.examples.filter(example => example.kind === 'unflagged').map(example => example.userId);
    expect(unflagged).toHaveLength(10);
    expect(new Set(unflagged).size).toBe(10);
    expect(unflagged.some(userId => flagged.has(userId))).toBe(false);
    expect(set.population).toEqual({ flagged: 4, unflagged: 41 });
    // The drawn ids are the set: reading it again gives the same examples.
    const reread = await abuseEvalSetRepository.findById(id);
    expect(reread?.examples.map(example => example.userId)).toEqual(set.examples.map(example => example.userId));
  });

  it('links a campaign member that the detection does not name without flagging it', async () => {
    const world = await seedWorld();
    const transitive = await seedUser({});
    await seedDetection([world.legitFlagged], 'confirmed_abuse', [world.legitFlagged, transitive]);

    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    expect(set.population).toEqual({ flagged: 4, unflagged: 42 });
    const byUser = new Map(set.examples.map(example => [example.userId, example]));
    const member = byUser.get(transitive);
    if (!member) throw new Error('the campaign member was not sampled');
    expect(member).toMatchObject({ kind: 'unflagged', detectionIds: [], frozenLabel: null });
    const direct = byUser.get(world.legitFlagged);
    expect(member.campaignKey).toBe(direct?.campaignKey);
    expect(member.split).toBe(direct?.split);
  });

  it('does not freeze an automation verdict as an admin verdict', async () => {
    await seedWorld();
    const automated = await seedUser({});
    await seedDetection([automated], 'confirmed_abuse', [], daysAgo(2), [
      {
        verdict: 'confirmed_abuse',
        source: 'automation',
        reviewerId: 'automation',
        reason: 'auto-graded',
        reviewedAt: daysAgo(1),
      },
    ]);

    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    const example = set.examples.find(candidate => candidate.userId === automated);
    if (!example) throw new Error('the automated account was not drawn');
    expect(example.kind).toBe('flagged');
    expect(example.frozenLabel).not.toMatchObject({ source: 'adminVerdict' });
    expect(example.frozenLabel).toBeNull();
  });
});

describe('drawEvalSet past the detection limit', () => {
  it('never samples an account flagged only by a detection past the limit as unflagged', async () => {
    await seedWorld();
    const flaggedPastLimit = await seedUser({});
    await seedDetection([flaggedPastLimit], null, [], daysAgo(10));

    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a', 2), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    expect(set.truncated).toBe(true);
    expect(set.examples.some(example => example.userId === flaggedPastLimit)).toBe(false);
    expect(set.population).toEqual({ flagged: 5, unflagged: 41 });
  });
});

describe('drawEvalSet campaign links', () => {
  it('links a sampled account to a flagged one through a detection before the window', async () => {
    const world = await seedWorld();
    const linkedBefore = await seedUser({});
    await seedDetection([world.legitFlagged, linkedBefore], 'confirmed_abuse', [], daysAgo(request.days + 10));

    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    if (!set) throw new Error('set was not stored');

    const byUser = new Map(set.examples.map(example => [example.userId, example]));
    const member = byUser.get(linkedBefore);
    const flagged = byUser.get(world.legitFlagged);
    if (!member || !flagged) throw new Error('the linked accounts were not drawn');
    // The old detection links the two; only in-window detections flag.
    expect(member).toMatchObject({ kind: 'unflagged', detectionIds: [] });
    expect(member.campaignKey).toBe(flagged.campaignKey);
    expect(member.split).toBe(flagged.split);
    expect(set.population.flagged).toBe(4);
  });
});

describe('shadow mode', () => {
  it('draws, labels and runs a set without writing to users, credits or usage', async () => {
    const world = await seedWorld();
    const snapshot = async () => ({
      users: await User.collection.find({}).sort({ _id: 1 }).toArray(),
      credits: await CreditTransaction.collection.find({}).sort({ _id: 1 }).toArray(),
      usage: await UsageEvent.collection.find({}).sort({ _id: 1 }).toArray(),
      detections: await ShadowDetectionModel.collection.find({}).sort({ _id: 1 }).toArray(),
    });
    const before = await snapshot();

    const id = await drawEvalSet(request, ADMIN_ID, deps('seed-a'), NOW);
    const set = await abuseEvalSetRepository.findById(id);
    const target = set?.examples.find(example => example.userId === world.sharedIpUnflagged);
    if (!set || !target) throw new Error('example was not drawn');
    expect(
      await abuseEvalSetRepository.addExampleVerdict({
        setId: id,
        userId: target.userId,
        expectedRevision: target.revision,
        verdict: 'confirmed_abuse',
        reason: 'same network as the farm',
        reviewerId: ADMIN_ID,
      })
    ).toBe('updated');
    const first = await runEvalSet(id, ADMIN_ID, 'first', deps('unused'), NOW);
    const second = await runEvalSet(id, ADMIN_ID, null, deps('unused'), NOW);

    expect(JSON.stringify(await snapshot())).toEqual(JSON.stringify(before));
    expect(await AbuseEvalSetModel.countDocuments()).toBe(1);
    expect(first.previous).toBeNull();
    expect(second.previous?.note).toBe('first');
    expect(second.run.report.examples).toBe(set.examples.filter(example => example.split === 'heldOut').length);
  });
});
