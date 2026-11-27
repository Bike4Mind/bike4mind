import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  calculateContentHash,
  parseFunctionContract,
  reviewHash,
  type ICallableFunctionGrants,
} from '@bike4mind/common';
import {
  Artifact,
  ArtifactContent,
  CallableFunction,
  CallableFunctionCall,
  CallableFunctionReview,
  Organization,
  Project,
  User,
  callableFunctionRepository,
  organizationRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('./access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => true),
  assertCallableFunctionsEnabled: vi.fn(async () => undefined),
  resolveOrganizationCallableFunctionsEnabled: vi.fn(async () => true),
}));

import { dispatchFunctionCall } from './dispatch';
import {
  canCallFunction,
  dropUncoveredCallableFunctionReviews,
  getCallableFunctionShare,
  listSharedCallableFunctions,
} from './sharing';
import { getCallableFunction, listCallableFunctions, summarizeCallableFunctionCalls } from './registry';
import {
  linkCallableFunctionDataForBrowser,
  readCallableFunctionData,
  type CallableFunctionDataStorage,
} from './dataPins';
import { reviewSharedCallableFunction } from './reviews';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const oid = () => new mongoose.Types.ObjectId().toHexString();
const OWNER = { id: oid() };
const PERSON = { id: oid() };
const PROJECT_MEMBER = { id: oid() };
const SIGNED_IN = { id: oid() };
const SIGNED_IN_TOO = { id: oid() };
const PROJECT_ID = oid();
const ORG_ID = oid();
const OWNER_KEY = { ownerType: 'user' as const, ownerKey: OWNER.id };
const MARK = { setBy: 'admin-1', setAt: new Date('2026-01-03T00:00:00Z') };

const SOURCE =
  'FUNCTION = {"name": "beam_midspan_deflection"}\n\ndef run(load, span):\n    return {"deflection": load * span / 384}\n';

const parsed = parseFunctionContract({
  name: 'beam_midspan_deflection',
  description: 'Midspan deflection of a simply supported beam under a uniform load.',
  inputs: {
    type: 'object',
    additionalProperties: false,
    required: ['load', 'span'],
    properties: { load: { type: 'number', unit: 'N/m' }, span: { type: 'number', unit: 'm' } },
  },
  outputs: {
    type: 'object',
    additionalProperties: false,
    required: ['deflection'],
    properties: { deflection: { type: 'number', unit: 'm' } },
  },
});
if (!parsed.ok) throw new Error('fixture contract must parse');
const CONTRACT = parsed.contract;
const ARGS = { load: 2000, span: 5 };

const runner = vi.fn(async () => ({ outcome: 'ok' as const, outputs: { deflection: 26.04 }, durationMs: 5 }));

async function seedPeople() {
  await User.collection.insertMany(
    [OWNER, PERSON, PROJECT_MEMBER, SIGNED_IN, SIGNED_IN_TOO].map((user, index) => ({
      _id: new mongoose.Types.ObjectId(user.id),
      name: `Person ${index}`,
      username: `person${index}`,
      email: `person${index}@example.com`,
    }))
  );
  await Project.collection.insertOne({
    _id: new mongoose.Types.ObjectId(PROJECT_ID),
    name: 'Bridges',
    userId: OWNER.id,
    users: [{ userId: PROJECT_MEMBER.id, permissions: ['read'] }],
  });
  await Organization.collection.insertOne({
    _id: new mongoose.Types.ObjectId(ORG_ID),
    name: 'Structures',
    personal: false,
    userId: OWNER.id,
    users: [],
  });
}

/** A live, verified function with its promotion kept, as a verified promotion leaves it. */
async function seedVerifiedFunction(slug: string, grants?: ICallableFunctionGrants) {
  const artifactId = `artifact-${slug}`;
  const contentHash = calculateContentHash(SOURCE);
  const contentSize = Buffer.byteLength(SOURCE, 'utf8');
  const row = await ArtifactContent.create({ artifactId, version: 1, content: SOURCE, contentHash, contentSize });
  await Artifact.create({
    id: artifactId,
    type: 'python',
    title: 'Beam deflection',
    version: 1,
    userId: OWNER.id,
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: row._id,
    contentHash,
    contentSize,
  });
  const pin = { artifactId, version: 1, contentHash, source: SOURCE, pinnedAt: new Date() };
  const fn = await callableFunctionRepository.create({
    ownerType: 'user',
    ownerKey: OWNER.id,
    userId: OWNER.id,
    slug,
    description: CONTRACT.description,
    enabled: true,
    pin,
    contract: CONTRACT,
  });
  await CallableFunction.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(fn.id) },
    {
      $set: {
        state: 'live',
        trustLabel: 'verified',
        'pin.seq': 1,
        promoted: { seq: 1, contract: CONTRACT, at: new Date(), pin: { ...pin, seq: 1 }, trustLabel: 'verified' },
      },
    }
  );
  if (grants) await callableFunctionRepository.setGrants(fn.id, OWNER_KEY, grants);
  return fn.id;
}

async function offerToEveryone(id: string) {
  await callableFunctionRepository.setPlatformMark(id, MARK);
  const offered = await callableFunctionRepository.setPlatformAudience(id, 'signed_in');
  if (!offered) throw new Error('the audience did not land');
  return offered;
}

const callAs = (caller: { id: string }, functionId: string) =>
  dispatchFunctionCall({ caller, functionId, args: ARGS, surface: 'rest' }, { runner });

const review = async (caller: { id: string }, id: string) =>
  reviewSharedCallableFunction(caller, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });

let mongoServer: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await CallableFunction.init();
  await CallableFunctionReview.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  runner.mockClear();
  await seedPeople();
});

afterEach(async () => {
  await Promise.all(
    [
      CallableFunction,
      CallableFunctionCall,
      CallableFunctionReview,
      Artifact,
      ArtifactContent,
      User,
      Project,
      Organization,
    ].map(model => model.collection.deleteMany({}))
  );
});

describe('a function offered to every signed-in person', () => {
  it('lists for anyone signed in as offered to them, and each person reviews it before their first call', async () => {
    const id = await seedVerifiedFunction('beam_midspan_deflection');
    expect(await listSharedCallableFunctions(SIGNED_IN)).toEqual([]);
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });

    await offerToEveryone(id);
    const [shared] = await listSharedCallableFunctions(SIGNED_IN);
    expect(shared).toMatchObject({
      id,
      sharedVia: 'signed_in',
      status: 'pending_review',
      trustLabel: 'platform',
      ownerName: 'Person 0',
      review: null,
    });
    expect(await listSharedCallableFunctions(OWNER)).toEqual([]);

    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect((await review(SIGNED_IN, id)).status).toBe('reviewed');
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'ok', outputs: { deflection: 26.04 } });
    expect(await callAs(SIGNED_IN_TOO, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('stops at once when the audience or the label is removed, or an edit unverifies or drafts it', async () => {
    const id = await seedVerifiedFunction('beam_midspan_deflection', { visibility: 'private', userIds: [PERSON.id] });
    await offerToEveryone(id);
    await review(SIGNED_IN, id);
    await review(PERSON, id);
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'ok' });

    const refusedEverywhere = async () => {
      expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
      expect(await listSharedCallableFunctions(SIGNED_IN)).toEqual([]);
      expect(await canCallFunction(SIGNED_IN, (await callableFunctionRepository.findById(id))!)).toBeNull();
    };

    await callableFunctionRepository.setPlatformAudience(id, null);
    await refusedEverywhere();
    await offerToEveryone(id);
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'ok' });

    await callableFunctionRepository.clearPlatformMark(id);
    await refusedEverywhere();

    const offered = await offerToEveryone(id);
    await callableFunctionRepository.setExamples(id, OWNER_KEY, { updatedAt: offered.updatedAt }, [], {
      unverify: true,
    });
    await refusedEverywhere();
    expect(await callableFunctionRepository.setPlatformAudience(id, 'signed_in')).toBeNull();

    await CallableFunction.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { trustLabel: 'verified' } }
    );
    await offerToEveryone(id);
    const live = await CallableFunction.findById(id).lean();
    const repinned = await callableFunctionRepository.repin(id, OWNER_KEY, 1, {
      pin: { ...live!.pin, version: 2, pinnedAt: new Date() },
      contract: CONTRACT,
      description: CONTRACT.description,
    });
    expect(repinned).toMatchObject({ state: 'draft', promoted: { seq: 1 } });
    await refusedEverywhere();
    // A person named in the grants keeps the kept promotion meanwhile; the audience never does.
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
  });

  it('starts a person at pending again when the audience comes back after an admin removed it', async () => {
    const id = await seedVerifiedFunction('beam_midspan_deflection', { visibility: 'private', userIds: [PERSON.id] });
    await offerToEveryone(id);
    await review(SIGNED_IN, id);
    await review(PERSON, id);

    const withdrawn = await callableFunctionRepository.setPlatformAudience(id, null);
    await dropUncoveredCallableFunctionReviews(withdrawn!);
    await offerToEveryone(id);
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
  });

  it("keeps the function's code, data, and call log with its owner", async () => {
    const id = await seedVerifiedFunction('beam_midspan_deflection');
    await offerToEveryone(id);
    await review(SIGNED_IN, id);
    expect(await callAs(SIGNED_IN, id)).toMatchObject({ outcome: 'ok' });

    const storage = {} as CallableFunctionDataStorage;
    const reads: [string, () => Promise<unknown>][] = [
      ['get', () => getCallableFunction(SIGNED_IN, id)],
      ['calls', () => summarizeCallableFunctionCalls(SIGNED_IN, id)],
      ['share read', () => getCallableFunctionShare(SIGNED_IN, id)],
      ['data bytes', () => readCallableFunctionData(SIGNED_IN, id, 'points.csv', { storage })],
      ['data link', () => linkCallableFunctionDataForBrowser(SIGNED_IN, id, 'points.csv', { storage })],
    ];
    for (const [name, read] of reads) {
      await expect(read(), name).rejects.toThrow('not found');
    }
    expect(await listCallableFunctions(SIGNED_IN)).toEqual([]);
    const listed = JSON.stringify(await listSharedCallableFunctions(SIGNED_IN));
    expect(listed).not.toContain('def run');
    expect(listed).not.toContain('artifact-');
    expect(await summarizeCallableFunctionCalls(OWNER, id)).toBeTruthy();
  });

  it('makes no one a member of the project or organization the function is also shared with', async () => {
    const offered = await seedVerifiedFunction('beam_midspan_deflection', {
      visibility: 'project',
      projectId: PROJECT_ID,
      userIds: [],
    });
    const projectOnly = await seedVerifiedFunction('column_buckling', {
      visibility: 'project',
      projectId: PROJECT_ID,
      userIds: [],
    });
    const orgOnly = await seedVerifiedFunction('slab_punching', {
      visibility: 'organization',
      organizationId: ORG_ID,
      userIds: [],
    });
    await offerToEveryone(offered);

    expect(await canCallFunction(PROJECT_MEMBER, (await callableFunctionRepository.findById(offered))!)).toBe(
      'project'
    );
    expect(await canCallFunction(SIGNED_IN, (await callableFunctionRepository.findById(offered))!)).toBe('signed_in');
    await review(SIGNED_IN, offered);
    expect(await callAs(SIGNED_IN, offered)).toMatchObject({ outcome: 'ok' });

    expect((await listSharedCallableFunctions(SIGNED_IN)).map(fn => [fn.id, fn.sharedVia])).toEqual([
      [offered, 'signed_in'],
    ]);
    expect(await callAs(SIGNED_IN, projectOnly)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await callAs(SIGNED_IN, orgOnly)).toMatchObject({ outcome: 'refused', reason: 'not_found' });

    const project = await Project.collection.findOne({ _id: new mongoose.Types.ObjectId(PROJECT_ID) });
    expect(project?.users).toEqual([{ userId: PROJECT_MEMBER.id, permissions: ['read'] }]);
    expect(await organizationRepository.findMembershipOrgIds(SIGNED_IN.id)).toEqual([]);
    const org = await Organization.collection.findOne({ _id: new mongoose.Types.ObjectId(ORG_ID) });
    expect(org?.users).toEqual([]);
  });
});
