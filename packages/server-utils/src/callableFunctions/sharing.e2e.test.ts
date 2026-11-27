import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  CallableFunctionProtectedFieldError,
  calculateContentHash,
  parseFunctionContract,
  recipientCallableFunction,
  reviewHash,
  type FunctionContract,
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
  callableFunctionReviewRepository,
} from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const h = vi.hoisted(() => ({ orgSettingOn: {} as Record<string, boolean> }));

// Every caller passes their own setting check here, so each refusal below is canCallFunction's.
vi.mock('./access', () => ({
  resolveCallableFunctionsEnabled: vi.fn(async () => true),
  assertCallableFunctionsEnabled: vi.fn(async () => undefined),
  resolveOrganizationCallableFunctionsEnabled: vi.fn(
    async (_user: { id: string }, organizationId: string) => h.orgSettingOn[organizationId] === true
  ),
}));

import { resolveOrganizationCallableFunctionsEnabled } from './access';
import { findCallerFunction, listCallerFunctions } from './callerFunctions';
import { dispatchFunctionCall } from './dispatch';
import {
  canCallFunction,
  findCallableFunctionRecipient,
  getCallableFunctionShare,
  listSharedCallableFunctions,
  revokeCallableFunctionShare,
  shareCallableFunction,
} from './sharing';
import {
  deleteCallableFunction,
  getCallableFunction,
  listCallableFunctions,
  repinCallableFunction,
  setCallableFunctionEnabled,
  setCallableFunctionExamples,
  summarizeCallableFunctionCalls,
} from './registry';
import type { CallableFunctionDataStorage } from './dataPins';
import { promoteCallableFunction } from './promote';
import {
  callableFunctionOffer,
  deleteReviewsOfOwnedCallableFunctions,
  hasCurrentReview,
  reviewSharedCallableFunction,
  updateSharedCallableFunctionReview,
} from './reviews';
import { runCallableFunctionTests } from './testRun';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const oid = () => new mongoose.Types.ObjectId().toHexString();
const OWNER = { id: oid() };
const PERSON = { id: oid() };
const PROJECT_MEMBER = { id: oid() };
const ORG_MEMBER = { id: oid() };
const STRANGER = { id: oid() };
const PROJECT_ID = oid();
const ORG_ID = oid();
const ARTIFACT_ID = 'artifact-share-1';

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
    [OWNER, PERSON, PROJECT_MEMBER, ORG_MEMBER, STRANGER].map((user, index) => ({
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
    users: [{ userId: ORG_MEMBER.id, permissions: ['read'] }],
  });
}

async function seedLiveFunction(grants?: ICallableFunctionGrants) {
  const contentHash = calculateContentHash(SOURCE);
  const contentSize = Buffer.byteLength(SOURCE, 'utf8');
  const row = await ArtifactContent.create({
    artifactId: ARTIFACT_ID,
    version: 1,
    content: SOURCE,
    contentHash,
    contentSize,
  });
  await Artifact.create({
    id: ARTIFACT_ID,
    type: 'python',
    title: 'Beam deflection',
    version: 1,
    userId: OWNER.id,
    permissions: { canRead: [], canWrite: [], canDelete: [] },
    contentId: row._id,
    contentHash,
    contentSize,
  });
  const fn = await callableFunctionRepository.create({
    ownerType: 'user',
    ownerKey: OWNER.id,
    userId: OWNER.id,
    slug: CONTRACT.name,
    description: CONTRACT.description,
    enabled: true,
    pin: { artifactId: ARTIFACT_ID, version: 1, contentHash, source: SOURCE, pinnedAt: new Date() },
    contract: CONTRACT,
  });
  // `create` writes only drafts; promotion's fields go straight to the collection.
  await CallableFunction.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(fn.id) },
    { $set: { state: 'live', trustLabel: 'unverified', 'pin.seq': 1 } }
  );
  if (grants) await callableFunctionRepository.setGrants(fn.id, { ownerType: 'user', ownerKey: OWNER.id }, grants);
  return fn.id;
}

const refusal = (code: string) => ({ additionalInfo: { code } });

const callAs = (caller: { id: string }, functionId: string) =>
  dispatchFunctionCall({ caller, functionId, args: ARGS, surface: 'rest' }, { runner });

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
  h.orgSettingOn = { [ORG_ID]: true };
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

describe('the access matrix, through the dispatcher', () => {
  it('runs for the owner, refuses every unreviewed recipient, and refuses everyone else as not a caller', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });

    expect(await callAs(OWNER, byOrg)).toMatchObject({ outcome: 'ok', outputs: { deflection: 26.04 } });
    expect(await callAs(PERSON, byOrg)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    expect(await callAs(PROJECT_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await callAs(STRANGER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(runner).toHaveBeenCalledTimes(1);

    const rows = await CallableFunctionCall.find({ functionId: byOrg }).sort({ startedAt: 1, _id: 1 }).lean();
    expect(rows.map(row => [row.callerUserId, row.outcome, row.reason ?? null])).toEqual([
      [OWNER.id, 'ok', null],
      [PERSON.id, 'refused', 'review_required'],
      [ORG_MEMBER.id, 'refused', 'review_required'],
      [PROJECT_MEMBER.id, 'refused', 'not_caller'],
      [STRANGER.id, 'refused', 'not_caller'],
    ]);
  });

  it('refuses an organization member once that organization turns callable functions off', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    h.orgSettingOn[ORG_ID] = false;
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    const grants = { visibility: 'organization' as const, organizationId: ORG_ID, userIds: [] };
    expect(
      await canCallFunction(ORG_MEMBER, { ownerType: 'user', ownerKey: OWNER.id, state: 'live', grants })
    ).toBeNull();
    expect(await listSharedCallableFunctions(ORG_MEMBER)).toEqual([]);
  });

  it('ends an organization share when the owner leaves the organization, at the next call and the next list', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ reason: 'review_required' });

    await Organization.collection.updateOne({ _id: new mongoose.Types.ObjectId(ORG_ID) }, { $set: { userId: oid() } });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(ORG_MEMBER)).toEqual([]);
    expect(await callAs(PERSON, byOrg)).toMatchObject({ reason: 'review_required' });
  });

  it('ends a project share when the owner leaves the project, at the next call and the next list', async () => {
    const byProject = await seedLiveFunction({ visibility: 'project', projectId: PROJECT_ID, userIds: [] });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ reason: 'review_required' });
    expect((await listSharedCallableFunctions(PROJECT_MEMBER)).map(fn => fn.id)).toEqual([byProject]);

    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(PROJECT_ID) }, { $set: { userId: oid() } });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(PROJECT_MEMBER)).toEqual([]);
  });

  it('refuses every recipient while a repin leaves a function with no kept promotion a draft', async () => {
    const id = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });
    const owner = { ownerType: 'user' as const, ownerKey: OWNER.id };
    const live = await CallableFunction.findById(id).lean();
    const repinned = await callableFunctionRepository.repin(id, owner, 1, {
      pin: { ...live!.pin, version: 2, pinnedAt: new Date() },
      contract: CONTRACT,
      description: CONTRACT.description,
    });
    expect(repinned).toMatchObject({ state: 'draft', grants: { userIds: [PERSON.id] } });

    runner.mockClear();
    for (const recipient of [PERSON, ORG_MEMBER]) {
      expect(await callAs(recipient, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
      expect(await canCallFunction(recipient, repinned!)).toBeNull();
      expect(await listSharedCallableFunctions(recipient)).toEqual([]);
    }
    expect(runner).not.toHaveBeenCalled();
    expect(await canCallFunction(OWNER, repinned!)).toBe('owner');
  });

  it('keeps recipients on the last promotion while the owner edits, and moves them at the next one', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const owner = { ownerType: 'user' as const, ownerKey: OWNER.id };
    const promote = async (seq: number) => {
      const current = await callableFunctionRepository.findByIdForOwner(id, owner);
      return callableFunctionRepository.promote(
        id,
        owner,
        { updatedAt: current!.updatedAt },
        {
          seq,
          runtime: { kind: 'pyodide-server', version: '0.25.1', packages: [] },
          lastServerRun: { at: new Date(), passed: 0, failed: 0, results: [] },
          trustLabel: 'unverified',
          contract: CONTRACT,
          sourcePins: [],
          pin: current!.pin,
          description: current!.description,
        }
      );
    };
    await promote(1);
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    const codeRun = () => (runner.mock.calls.at(-1) as unknown as [{ code: string }])[0].code;

    const edited = `${SOURCE}# edited\n`;
    const repinned = await callableFunctionRepository.repin(id, owner, 1, {
      pin: {
        artifactId: ARTIFACT_ID,
        version: 2,
        contentHash: calculateContentHash(edited),
        source: edited,
        pinnedAt: new Date(),
      },
      contract: CONTRACT,
      description: CONTRACT.description,
    });
    expect(repinned).toMatchObject({ state: 'draft' });
    expect(await canCallFunction(PERSON, repinned!)).toBe('person');
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
    expect(codeRun()).toBe(SOURCE);
    const [shared] = await listSharedCallableFunctions(PERSON);
    expect(shared).toMatchObject({ id, status: 'reviewed', pin: { version: 1, seq: 1 } });
    expect(JSON.stringify(shared)).not.toContain('def run');
    const [row] = await CallableFunctionCall.find({ functionId: id }).sort({ startedAt: -1 }).limit(1).lean();
    expect(row).toMatchObject({ callerUserId: PERSON.id, ownerUserId: OWNER.id, pinSeq: 1 });

    expect(await promote(2)).toMatchObject({ state: 'live', pin: { version: 2, seq: 2 } });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
    expect(codeRun()).toBe(edited);
  });

  it('reads a promotion saved without its pin as none kept: live runs, and a repin refuses recipients as before', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const owner = { ownerType: 'user' as const, ownerKey: OWNER.id };
    await CallableFunction.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { promoted: { seq: 1, contract: CONTRACT, at: new Date() } } }
    );
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });

    const live = await CallableFunction.findById(id).lean();
    const repinned = await callableFunctionRepository.repin(id, owner, 1, {
      pin: { ...live!.pin, version: 2, pinnedAt: new Date() },
      contract: CONTRACT,
      description: CONTRACT.description,
    });
    expect(repinned).toMatchObject({ state: 'draft', promoted: { seq: 1 } });
    expect(repinned!.promoted!.pin).toBeUndefined();
    expect(recipientCallableFunction(repinned!)).toBeNull();
    expect(await canCallFunction(PERSON, repinned!)).toBeNull();
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);
  });

  it('refuses a reviewed recipient at once when the owner turns the function off, on the kept promotion too', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });

    await setCallableFunctionEnabled(OWNER, id, false);
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);

    await setCallableFunctionEnabled(OWNER, id, true);
    const live = await CallableFunction.findById(id).lean();
    await CallableFunction.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(id) },
      { $set: { state: 'draft', promoted: { seq: 1, contract: CONTRACT, at: new Date(), pin: live!.pin } } }
    );
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
    await setCallableFunctionEnabled(OWNER, id, false);
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'disabled' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);
  });

  it('admits a project member, and refuses them at the next call after they leave', async () => {
    const byProject = await seedLiveFunction({ visibility: 'project', projectId: PROJECT_ID, userIds: [] });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ reason: 'review_required' });
    expect(await callAs(ORG_MEMBER, byProject)).toMatchObject({ reason: 'not_found' });

    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(PROJECT_ID) }, { $set: { users: [] } });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
  });

  it('refuses a former organization member at the next call', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ reason: 'review_required' });

    await Organization.collection.updateOne({ _id: new mongoose.Types.ObjectId(ORG_ID) }, { $set: { users: [] } });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
  });

  it('reads a project or organization id in the grants only under its own visibility', async () => {
    const privateShare = await seedLiveFunction({
      visibility: 'private',
      projectId: PROJECT_ID,
      organizationId: ORG_ID,
      userIds: [PERSON.id],
    });
    expect(await callAs(PROJECT_MEMBER, privateShare)).toMatchObject({ reason: 'not_found' });
    expect(await callAs(ORG_MEMBER, privateShare)).toMatchObject({ reason: 'not_found' });
  });

  it('writes one dispatch_failed row when the access check throws', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    vi.mocked(resolveOrganizationCallableFunctionsEnabled).mockRejectedValueOnce(new Error('settings read failed'));
    await expect(callAs(ORG_MEMBER, byOrg)).rejects.toThrow('settings read failed');

    const rows = await CallableFunctionCall.find({ functionId: byOrg }).lean();
    expect(rows.map(row => [row.callerUserId, row.outcome, row.reason ?? null])).toEqual([
      [ORG_MEMBER.id, 'error', 'dispatch_failed'],
    ]);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('revoking', () => {
  it('takes effect on the next call and the next list', async () => {
    const id = await seedLiveFunction();
    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    expect(await callAs(PERSON, id)).toMatchObject({ reason: 'review_required' });
    expect((await listSharedCallableFunctions(PERSON)).map(fn => fn.id)).toEqual([id]);

    const revoked = await revokeCallableFunctionShare(OWNER, id);
    expect(revoked.grants).toBeNull();
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);
  });

  it('deletes the reviews, so a later share of the same interface starts at pending', async () => {
    const id = await seedLiveFunction();
    const people = { visibility: 'private' as const, userIds: [PERSON.id] };
    await shareCallableFunction(OWNER, id, people);
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });

    await revokeCallableFunctionShare(OWNER, id);
    expect(await CallableFunctionReview.countDocuments({ functionId: id })).toBe(0);

    await shareCallableFunction(OWNER, id, people);
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
  });

  it('ends the review of a person a share edit drops, so adding them back starts at pending', async () => {
    const id = await seedLiveFunction();
    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [STRANGER.id] });
    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
  });

  it('keeps the review of a person who stays in the share when the edit adds someone', async () => {
    const id = await seedLiveFunction();
    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id, STRANGER.id] });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
  });

  it('ends the reviews of everyone outside the new grant when the share changes scope, and keeps the named people', async () => {
    const id = await seedLiveFunction();
    await shareCallableFunction(OWNER, id, {
      visibility: 'organization',
      organizationId: ORG_ID,
      userIds: [PERSON.id],
    });
    const hash = await reviewHash(CONTRACT);
    await reviewSharedCallableFunction(ORG_MEMBER, id, { reviewHash: hash, approval: 'default' });
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: hash, approval: 'default' });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    const kept = await CallableFunctionReview.find({ functionId: id }).lean();
    expect(kept.map(row => row.userId)).toEqual([PERSON.id]);
  });

  it('keeps the review of a member the wider scope still covers when a project share becomes an organization share', async () => {
    await Organization.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(ORG_ID) },
      { $push: { users: { userId: PROJECT_MEMBER.id, permissions: ['read'] } } as never }
    );
    const id = await seedLiveFunction({ visibility: 'project', projectId: PROJECT_ID, userIds: [] });
    await reviewSharedCallableFunction(PROJECT_MEMBER, id, {
      reviewHash: await reviewHash(CONTRACT),
      approval: 'always_ask',
    });
    expect(await callAs(PROJECT_MEMBER, id)).toMatchObject({ outcome: 'ok' });

    await shareCallableFunction(OWNER, id, { visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    expect(await callAs(PROJECT_MEMBER, id)).toMatchObject({ outcome: 'ok' });
    const [shared] = await listSharedCallableFunctions(PROJECT_MEMBER);
    expect(shared).toMatchObject({ sharedVia: 'organization', status: 'reviewed', review: { approval: 'always_ask' } });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    expect(await CallableFunctionReview.countDocuments({ functionId: id, userId: PROJECT_MEMBER.id })).toBe(0);
  });
});

describe('the caller list and lookup behind the public routes, unreviewed entries included', () => {
  const reach = async (caller: { id: string }, id: string) => {
    const listed = await listCallerFunctions(caller, { includeUnreviewed: true });
    const lookup = await findCallerFunction(caller, { id });
    return {
      listed: listed.map(entry => [entry.fn.id, entry.access]),
      found: 'found' in lookup ? lookup.found.access : lookup.refused,
    };
  };
  const leave = (model: typeof Project | typeof Organization, id: string) => () =>
    model.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { users: [] } });

  it.each<[string, ICallableFunctionGrants, { id: string }, string, (id: string) => Promise<unknown>]>([
    [
      'a person the owner drops from the share',
      { visibility: 'private', userIds: [PERSON.id] },
      PERSON,
      'person',
      id => shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [STRANGER.id] }),
    ],
    [
      'a person after the owner stops sharing',
      { visibility: 'private', userIds: [PERSON.id] },
      PERSON,
      'person',
      id => revokeCallableFunctionShare(OWNER, id),
    ],
    [
      'a project member who leaves the project',
      { visibility: 'project', projectId: PROJECT_ID, userIds: [] },
      PROJECT_MEMBER,
      'project',
      leave(Project, PROJECT_ID),
    ],
    [
      'an organization member who leaves the organization',
      { visibility: 'organization', organizationId: ORG_ID, userIds: [] },
      ORG_MEMBER,
      'organization',
      leave(Organization, ORG_ID),
    ],
  ])('reaches %s until that access ends, an allow on file or not', async (_name, grants, recipient, access, end) => {
    const id = await seedLiveFunction(grants);
    expect(await reach(recipient, id)).toEqual({ listed: [[id, access]], found: access });
    expect(await reach(STRANGER, id)).toEqual({ listed: [], found: 'not_found' });

    await reviewSharedCallableFunction(recipient, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    await end(id);
    expect(await reach(recipient, id)).toEqual({ listed: [], found: 'not_found' });
  });
});

describe('a re-review', () => {
  it('lists what changed in the interface since the review, field by field', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect((await listSharedCallableFunctions(PERSON))[0]).toMatchObject({ status: 'reviewed', changes: [] });

    const changed: FunctionContract = {
      ...CONTRACT,
      description: 'Midspan deflection of a beam under a uniform load, with an optional factor.',
      inputs: {
        ...CONTRACT.inputs,
        properties: { ...CONTRACT.inputs.properties, factor: { type: 'number', unit: '1' } },
      },
      outputs: {
        ...CONTRACT.outputs,
        properties: { deflection: { type: 'number', unit: 'mm' } },
      },
    };
    await CallableFunction.updateOne({ _id: id }, { $set: { contract: changed, description: changed.description } });

    const [shared] = await listSharedCallableFunctions(PERSON);
    expect(shared!.status).toBe('pending_review');
    expect(shared!.changes!.map(({ path, kind }) => ({ path, kind }))).toEqual(
      expect.arrayContaining([
        { path: 'description', kind: 'description_changed' },
        { path: 'inputs.factor', kind: 'added' },
        { path: 'outputs.deflection.unit', kind: 'unit_changed' },
      ])
    );
    expect(shared!.changes).toHaveLength(3);
  });
});

describe('naming a person by address', () => {
  it('finds an account outside every organization and project of the owner, and nothing for an unknown address', async () => {
    const id = await seedLiveFunction();
    expect(await findCallableFunctionRecipient(OWNER, id, ' person4@example.com ')).toEqual({
      id: STRANGER.id,
      name: 'Person 4',
    });
    expect(await findCallableFunctionRecipient(OWNER, id, 'nobody@example.com')).toBeNull();
    await expect(findCallableFunctionRecipient(STRANGER, id, 'person1@example.com')).rejects.toMatchObject({
      message: 'Tool not found',
    });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [STRANGER.id] });
    await reviewSharedCallableFunction(STRANGER, id, { reviewHash: await reviewHash(CONTRACT), approval: 'default' });
    expect(await callAs(STRANGER, id)).toMatchObject({ outcome: 'ok' });
  });
});

describe('shareCallableFunction', () => {
  it('stores the grants without the owner or duplicates and names the people', async () => {
    const id = await seedLiveFunction();
    const saved = await shareCallableFunction(OWNER, id, {
      visibility: 'project',
      projectId: PROJECT_ID,
      userIds: [PERSON.id, PERSON.id, OWNER.id],
    });
    expect(saved.grants).toEqual({ visibility: 'project', projectId: PROJECT_ID, userIds: [PERSON.id] });
    expect(await getCallableFunctionShare(OWNER, id)).toEqual({
      grants: saved.grants,
      people: [{ id: PERSON.id, name: 'Person 1' }],
    });
  });

  it('refuses more than 50 people, in the service and in the record', async () => {
    const id = await seedLiveFunction();
    const many = Array.from({ length: 51 }, oid);
    await expect(shareCallableFunction(OWNER, id, { visibility: 'private', userIds: many })).rejects.toMatchObject(
      refusal('too_many_people')
    );
    const owner = { ownerType: 'user' as const, ownerKey: OWNER.id };
    await expect(
      callableFunctionRepository.setGrants(id, owner, { visibility: 'private', userIds: many })
    ).rejects.toThrow(/At most 50 people/);
    expect((await CallableFunction.findById(id).lean())?.grants).toBeUndefined();
  });

  it('answers alike for an id with no account and one with an account, and names neither by email', async () => {
    const id = await seedLiveFunction();
    const missing = oid();
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(PERSON.id) }, { $unset: { name: 1 } });
    const withMissing = await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [missing] });
    const withPerson = await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] });
    expect(withMissing.grants).toEqual({ visibility: 'private', userIds: [missing] });
    expect(withPerson.grants).toEqual({ visibility: 'private', userIds: [PERSON.id] });

    await shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [missing, PERSON.id, STRANGER.id] });
    const view = await getCallableFunctionShare(OWNER, id);
    expect(view.people).toEqual([
      { id: missing, name: 'Unnamed person' },
      { id: PERSON.id, name: 'Unnamed person' },
      { id: STRANGER.id, name: 'Person 4' },
    ]);
    expect(JSON.stringify(view)).not.toContain('@example.com');
  });

  it('drops a function whose artifact was deleted from the shared list', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    expect((await listSharedCallableFunctions(PERSON)).map(fn => fn.id)).toEqual([id]);
    await Artifact.updateOne({ id: ARTIFACT_ID }, { $set: { deletedAt: new Date() } });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);
  });

  it('refuses a draft, a malformed id, no recipients, and a project or organization the owner is not in', async () => {
    const id = await seedLiveFunction();
    await expect(
      shareCallableFunction(OWNER, id, { visibility: 'private', userIds: ['not-an-id'] })
    ).rejects.toMatchObject(refusal('invalid_person'));
    await expect(shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [] })).rejects.toMatchObject(
      refusal('no_recipients')
    );
    await expect(
      shareCallableFunction(OWNER, id, { visibility: 'project', projectId: oid(), userIds: [] })
    ).rejects.toThrow('Project not found');
    await expect(
      shareCallableFunction(OWNER, id, { visibility: 'organization', organizationId: oid(), userIds: [] })
    ).rejects.toThrow('Organization not found');

    await CallableFunction.updateOne({ _id: id }, { $set: { state: 'draft' } });
    await expect(
      shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [PERSON.id] })
    ).rejects.toMatchObject(refusal('not_live'));
  });

  it('cannot be written through the generic writers', async () => {
    const id = await seedLiveFunction();
    const grants = { visibility: 'private', userIds: [STRANGER.id] };
    await expect(callableFunctionRepository.update({ id, grants } as never)).rejects.toBeInstanceOf(
      CallableFunctionProtectedFieldError
    );
    await expect(
      callableFunctionRepository.updateMany({ _id: id }, { 'grants.userIds': [STRANGER.id] } as never)
    ).rejects.toBeInstanceOf(CallableFunctionProtectedFieldError);
    expect((await CallableFunction.findById(id).lean())?.grants).toBeUndefined();
  });
});

describe('what a recipient can read', () => {
  it('lists the function as pending review with its interface and owner name, and no code, artifact, or grants', async () => {
    const id = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });
    const [shared] = await listSharedCallableFunctions(ORG_MEMBER);
    expect(shared).toMatchObject({
      id,
      status: 'pending_review',
      sharedVia: 'organization',
      ownerName: 'Person 0',
      inputs: CONTRACT.inputs,
      outputs: CONTRACT.outputs,
      reviewHash: await reviewHash(CONTRACT),
      review: null,
      dataPins: [],
      sources: [],
    });
    expect(Object.keys(shared!)).not.toEqual(expect.arrayContaining(['contract', 'grants', 'examples', 'userId']));
    expect(Object.keys(shared!.pin).sort()).toEqual(['pinnedAt', 'seq', 'version']);
    expect(JSON.stringify(await listSharedCallableFunctions(PERSON))).not.toContain('def run');
    expect(await listSharedCallableFunctions(STRANGER)).toEqual([]);
    expect(await listSharedCallableFunctions(OWNER)).toEqual([]);
  });

  it('is not found on every route that returns a function, and none of them answers with the code', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const pin = { expectedVersion: 1, contract: CONTRACT };
    const reads: [string, () => Promise<unknown>][] = [
      ['get', () => getCallableFunction(PERSON, id)],
      ['enable', () => setCallableFunctionEnabled(PERSON, id, false)],
      ['repin', () => repinCallableFunction(PERSON, id, pin)],
      ['examples', () => setCallableFunctionExamples(PERSON, id, [])],
      ['calls', () => summarizeCallableFunctionCalls(PERSON, id)],
      ['share read', () => getCallableFunctionShare(PERSON, id)],
      ['share', () => shareCallableFunction(PERSON, id, { visibility: 'private', userIds: [STRANGER.id] })],
      ['revoke', () => revokeCallableFunctionShare(PERSON, id)],
      ['promote', () => promoteCallableFunction(PERSON, id)],
      ['test run', () => runCallableFunctionTests(PERSON, id)],
      ['delete', () => deleteCallableFunction(PERSON, id)],
    ];
    for (const [name, read] of reads) {
      await expect(read(), name).rejects.toThrow('not found');
    }
    expect(await listCallableFunctions(PERSON)).toEqual([]);
    expect(await listCallableFunctions(PERSON, { artifactId: ARTIFACT_ID })).toEqual([]);
    expect((await CallableFunction.findById(id).lean())?.grants?.userIds).toEqual([PERSON.id]);
  });
});

describe('a recipient review', () => {
  const OWNER_KEY = { ownerType: 'user' as const, ownerKey: OWNER.id };

  /** A new pin promoted to live, as the Function tab's repin and promote leave it. */
  async function repinLive(id: string, contract: FunctionContract, source = SOURCE) {
    const live = await CallableFunction.findById(id).lean();
    await callableFunctionRepository.repin(id, OWNER_KEY, live!.pin.version, {
      pin: {
        ...live!.pin,
        version: live!.pin.version + 1,
        source,
        contentHash: calculateContentHash(source),
        pinnedAt: new Date(),
      },
      contract,
      description: contract.description,
    });
    await CallableFunction.updateOne({ _id: id }, { $set: { state: 'live', 'pin.seq': (live!.pin.seq ?? 0) + 1 } });
  }

  const review = async (caller: { id: string }, id: string, approval: 'default' | 'always_ask' = 'default') =>
    reviewSharedCallableFunction(caller, id, { reviewHash: await reviewHash(CONTRACT), approval });

  it('lets a recipient run only with a current, enabled review, with one call-log row per call', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });

    const reviewed = await review(PERSON, id);
    expect(reviewed).toMatchObject({
      status: 'reviewed',
      review: { approval: 'default', enabled: true, current: true },
    });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok', outputs: { deflection: 26.04 } });

    const off = await updateSharedCallableFunctionReview(PERSON, id, { enabled: false });
    expect(off.status).toBe('disabled');
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });

    expect((await updateSharedCallableFunctionReview(PERSON, id, { enabled: true })).status).toBe('reviewed');
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });

    const rows = await CallableFunctionCall.find({ functionId: id }).sort({ startedAt: 1, _id: 1 }).lean();
    expect(rows.map(row => [row.outcome, row.reason ?? null])).toEqual([
      ['refused', 'review_required'],
      ['ok', null],
      ['refused', 'review_required'],
      ['ok', null],
    ]);
  });

  it('carries the review across a repin that changes only the code', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await review(PERSON, id);
    await repinLive(id, CONTRACT, SOURCE.replace('/ 384', '/ 385'));

    expect(await hasCurrentReview(PERSON.id, { id, contract: CONTRACT })).toBe(true);
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
    const [shared] = await listSharedCallableFunctions(PERSON);
    expect(shared).toMatchObject({ status: 'reviewed', pin: { version: 2, seq: 2 } });
  });

  it('drafts the function on a pin change, then keeps the review of an unchanged interface and names the new pins', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const pinOf = (name: string, digit: string) => ({
      name,
      sha256: digit.repeat(64),
      bytes: 12,
      sourceFileId: oid(),
      pinnedAt: new Date(),
    });
    const setPins = async (pins: ReturnType<typeof pinOf>[]) => {
      const current = await CallableFunction.findById(id).lean();
      return callableFunctionRepository.setDataPins(id, OWNER_KEY, { updatedAt: current!.updatedAt }, pins);
    };
    const promoteAgain = async () => {
      const current = await CallableFunction.findById(id).lean();
      await CallableFunction.updateOne(
        { _id: id },
        { $set: { state: 'live', 'pin.seq': (current!.pin.seq ?? 0) + 1 } }
      );
    };

    await setPins([pinOf('points.csv', 'c')]);
    await promoteAgain();
    const [first] = await listSharedCallableFunctions(PERSON);
    expect(first).toMatchObject({ status: 'pending_review', dataPins: ['points.csv'] });
    expect(JSON.stringify(first)).not.toMatch(/c{64}/);
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: first!.reviewHash, approval: 'default' });

    // The review hash reads only the interface, as for the code; a pin change refuses everyone until the next promotion.
    expect(await setPins([pinOf('points.csv', 'c'), pinOf('loads.csv', 'd')])).toMatchObject({ state: 'draft' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);

    await promoteAgain();
    const [after] = await listSharedCallableFunctions(PERSON);
    expect(after).toMatchObject({
      status: 'reviewed',
      reviewHash: first!.reviewHash,
      dataPins: ['points.csv', 'loads.csv'],
    });
  });

  it.each<[string, FunctionContract]>([
    ['description', { ...CONTRACT, description: 'Midspan deflection, in meters.' }],
    ['name', { ...CONTRACT, name: 'beam_deflection' }],
    [
      'input schema',
      {
        ...CONTRACT,
        inputs: {
          ...CONTRACT.inputs,
          properties: { ...CONTRACT.inputs.properties, span: { type: 'number', unit: 'mm' } },
        },
      },
    ],
    [
      'output schema',
      {
        ...CONTRACT,
        outputs: {
          ...CONTRACT.outputs,
          properties: { deflection: { type: 'number', unit: 'm', description: 'Sag.' } },
        },
      },
    ],
  ])('returns the recipient to review after a %s change, until they review again', async (_change, changed) => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await review(PERSON, id);
    await repinLive(id, changed);

    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'review_required' });
    const [shared] = await listSharedCallableFunctions(PERSON);
    expect(shared).toMatchObject({ status: 'pending_review', review: { current: false } });
    expect(await callAs(OWNER, id)).toMatchObject({ outcome: 'ok' });

    // A review must name the interface the recipient was shown.
    await expect(review(PERSON, id)).rejects.toMatchObject(refusal('review_conflict'));
    await reviewSharedCallableFunction(PERSON, id, { reviewHash: shared!.reviewHash, approval: 'default' });
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'ok' });
  });

  it('never asks the owner for a review', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    expect(await callAs(OWNER, id)).toMatchObject({ outcome: 'ok' });
    await repinLive(id, { ...CONTRACT, description: 'Changed.' });
    expect(await callAs(OWNER, id)).toMatchObject({ outcome: 'ok' });
    expect(await CallableFunctionReview.countDocuments({})).toBe(0);
  });

  it('still refuses a stranger and a recipient whose grant was revoked, reviewed or not', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await review(PERSON, id);
    expect(await callAs(STRANGER, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });

    await revokeCallableFunctionShare(OWNER, id);
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(runner).not.toHaveBeenCalled();
    const rows = await CallableFunctionCall.find({ functionId: id }).sort({ startedAt: 1, _id: 1 }).lean();
    expect(rows.map(row => [row.callerUserId, row.reason])).toEqual([
      [STRANGER.id, 'not_caller'],
      [PERSON.id, 'not_caller'],
    ]);
  });

  it('answers not found to anyone the function is not shared with, the owner included', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const hash = await reviewHash(CONTRACT);
    const attempts: [string, () => Promise<unknown>][] = [
      ['stranger review', () => reviewSharedCallableFunction(STRANGER, id, { reviewHash: hash, approval: 'default' })],
      ['stranger settings', () => updateSharedCallableFunctionReview(STRANGER, id, { enabled: false })],
      ['owner review', () => reviewSharedCallableFunction(OWNER, id, { reviewHash: hash, approval: 'default' })],
      ['owner settings', () => updateSharedCallableFunctionReview(OWNER, id, { enabled: false })],
      [
        'malformed id',
        () => reviewSharedCallableFunction(PERSON, 'not-an-id', { reviewHash: hash, approval: 'default' }),
      ],
      ['missing id', () => updateSharedCallableFunctionReview(PERSON, oid(), { enabled: false })],
    ];
    for (const [name, attempt] of attempts) {
      await expect(attempt(), name).rejects.toThrow('not found');
    }

    await revokeCallableFunctionShare(OWNER, id);
    await expect(review(PERSON, id)).rejects.toThrow('not found');
    await expect(updateSharedCallableFunctionReview(PERSON, id, { enabled: true })).rejects.toThrow('not found');
    expect(await CallableFunctionReview.countDocuments({})).toBe(0);
  });

  it('refuses a settings change before any review', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await expect(updateSharedCallableFunctionReview(PERSON, id, { approval: 'always_allow' })).rejects.toMatchObject(
      refusal('not_reviewed')
    );
  });

  it('stores one review per function and person, and removes them with the function', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await review(PERSON, id);
    await review(PERSON, id, 'always_ask');
    const rows = await CallableFunctionReview.find({ functionId: id }).lean();
    expect(rows.map(row => [row.userId, row.approval, row.enabled])).toEqual([[PERSON.id, 'always_ask', true]]);
    await expect(CallableFunctionReview.create({ ...rows[0], _id: undefined, reviewedAt: new Date() })).rejects.toThrow(
      /duplicate key/
    );

    await deleteCallableFunction(OWNER, id, {
      deletePrefix: vi.fn(async () => 0),
    } as unknown as CallableFunctionDataStorage);
    expect(await CallableFunctionReview.countDocuments({})).toBe(0);
  });

  it("erases recipients' reviews of a function with its owner, and no one else's", async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    await review(PERSON, id);
    const elsewhere = { functionId: oid(), userId: PERSON.id, reviewHash: await reviewHash(CONTRACT) };
    await CallableFunctionReview.create({ ...elsewhere, approval: 'default', enabled: true, reviewedAt: new Date() });

    await deleteReviewsOfOwnedCallableFunctions(OWNER.id);
    expect((await CallableFunctionReview.find({}).lean()).map(row => row.functionId)).toEqual([elsewhere.functionId]);
  });

  it('saves two simultaneous reviews by the same person as one row, even when one loses the upsert race', async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const input = {
      functionId: id,
      userId: PERSON.id,
      reviewHash: await reviewHash(CONTRACT),
      approval: 'default' as const,
    };
    // The server can answer the losing upsert with a duplicate-key error; the second call is made to lose.
    const upsert = CallableFunctionReview.findOneAndUpdate.bind(CallableFunctionReview);
    let calls = 0;
    const spy = vi
      .spyOn(CallableFunctionReview, 'findOneAndUpdate')
      .mockImplementation(((...args: Parameters<typeof upsert>) =>
        ++calls === 2
          ? Promise.reject(Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }))
          : upsert(...args)) as typeof upsert);
    try {
      const saved = await Promise.all([
        callableFunctionReviewRepository.saveReview(input),
        callableFunctionReviewRepository.saveReview(input),
      ]);
      expect(saved.map(row => row.userId)).toEqual([PERSON.id, PERSON.id]);
    } finally {
      spy.mockRestore();
    }
    expect(await CallableFunctionReview.countDocuments({ functionId: id })).toBe(1);
  });
});

describe('callableFunctionOffer, for the chat loader', () => {
  it("offers a recipient's function only when reviewed, under their mode, and never always_ask when headless", async () => {
    const id = await seedLiveFunction({ visibility: 'private', userIds: [PERSON.id] });
    const fn = (await CallableFunction.findById(id))!.toJSON();
    const offer = (caller: { id: string }, headless: boolean) => callableFunctionOffer(caller, fn, { headless });

    expect(await offer(OWNER, true)).toEqual({ access: 'owner', approval: 'default' });
    expect(await offer(PERSON, false)).toBeNull();
    expect(await offer(STRANGER, false)).toBeNull();

    await reviewSharedCallableFunction(PERSON, id, { reviewHash: await reviewHash(CONTRACT), approval: 'always_ask' });
    expect(await offer(PERSON, false)).toEqual({ access: 'person', approval: 'always_ask' });
    expect(await offer(PERSON, true)).toBeNull();

    await updateSharedCallableFunctionReview(PERSON, id, { approval: 'always_allow' });
    expect(await offer(PERSON, true)).toEqual({ access: 'person', approval: 'always_allow' });

    await updateSharedCallableFunctionReview(PERSON, id, { enabled: false });
    expect(await offer(PERSON, false)).toBeNull();

    await updateSharedCallableFunctionReview(PERSON, id, { enabled: true });
    expect(await offer(PERSON, false)).not.toBeNull();
    const changed = { ...fn, contract: { ...CONTRACT, description: 'New.' } };
    expect(await callableFunctionOffer(PERSON, changed, { headless: false })).toBeNull();
  });
});
