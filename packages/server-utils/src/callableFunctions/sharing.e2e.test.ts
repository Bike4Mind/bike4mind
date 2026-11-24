import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  CallableFunctionProtectedFieldError,
  calculateContentHash,
  parseFunctionContract,
  type ICallableFunctionGrants,
} from '@bike4mind/common';
import {
  Artifact,
  ArtifactContent,
  CallableFunction,
  CallableFunctionCall,
  Organization,
  Project,
  User,
  callableFunctionRepository,
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
import { dispatchFunctionCall } from './dispatch';
import {
  canCallFunction,
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
import { promoteCallableFunction } from './promote';
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
    state: 'live',
    enabled: true,
    trustLabel: 'unverified',
    pin: { artifactId: ARTIFACT_ID, version: 1, contentHash, source: SOURCE, pinnedAt: new Date(), seq: 1 },
    contract: CONTRACT,
  });
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
    [CallableFunction, CallableFunctionCall, Artifact, ArtifactContent, User, Project, Organization].map(model =>
      model.collection.deleteMany({})
    )
  );
});

describe('the access matrix, through the dispatcher', () => {
  it('runs for the owner, refuses every recipient as pending review, and refuses everyone else as not a caller', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });

    expect(await callAs(OWNER, byOrg)).toMatchObject({ outcome: 'ok', outputs: { deflection: 26.04 } });
    expect(await callAs(PERSON, byOrg)).toMatchObject({ outcome: 'refused', reason: 'pending_review' });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'pending_review' });
    expect(await callAs(PROJECT_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await callAs(STRANGER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(runner).toHaveBeenCalledTimes(1);

    const rows = await CallableFunctionCall.find({ functionId: byOrg }).sort({ startedAt: 1 }).lean();
    expect(rows.map(row => [row.callerUserId, row.outcome, row.reason ?? null])).toEqual([
      [OWNER.id, 'ok', null],
      [PERSON.id, 'refused', 'pending_review'],
      [ORG_MEMBER.id, 'refused', 'pending_review'],
      [PROJECT_MEMBER.id, 'refused', 'not_caller'],
      [STRANGER.id, 'refused', 'not_caller'],
    ]);
  });

  it('refuses an organization member once that organization turns callable functions off', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    h.orgSettingOn[ORG_ID] = false;
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    const grants = { visibility: 'organization' as const, organizationId: ORG_ID, userIds: [] };
    expect(await canCallFunction(ORG_MEMBER, { ownerType: 'user', ownerKey: OWNER.id, grants })).toBeNull();
  });

  it('admits a project member, and refuses them at the next call after they leave', async () => {
    const byProject = await seedLiveFunction({ visibility: 'project', projectId: PROJECT_ID, userIds: [] });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ reason: 'pending_review' });
    expect(await callAs(ORG_MEMBER, byProject)).toMatchObject({ reason: 'not_found' });

    await Project.collection.updateOne({ _id: new mongoose.Types.ObjectId(PROJECT_ID) }, { $set: { users: [] } });
    expect(await callAs(PROJECT_MEMBER, byProject)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
  });

  it('refuses a former organization member at the next call', async () => {
    const byOrg = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [] });
    expect(await callAs(ORG_MEMBER, byOrg)).toMatchObject({ reason: 'pending_review' });

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
    expect(await callAs(PERSON, id)).toMatchObject({ reason: 'pending_review' });
    expect((await listSharedCallableFunctions(PERSON)).map(fn => fn.id)).toEqual([id]);

    const revoked = await revokeCallableFunctionShare(OWNER, id);
    expect(revoked.grants).toBeNull();
    expect(await callAs(PERSON, id)).toMatchObject({ outcome: 'refused', reason: 'not_found' });
    expect(await listSharedCallableFunctions(PERSON)).toEqual([]);
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

  it('refuses a draft, an unknown person, no recipients, and a project or organization the owner is not in', async () => {
    const id = await seedLiveFunction();
    await expect(shareCallableFunction(OWNER, id, { visibility: 'private', userIds: [oid()] })).rejects.toMatchObject(
      refusal('unknown_person')
    );
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
  it('lists the function as pending review with no code, artifact, examples, or grants', async () => {
    const id = await seedLiveFunction({ visibility: 'organization', organizationId: ORG_ID, userIds: [PERSON.id] });
    const [shared] = await listSharedCallableFunctions(ORG_MEMBER);
    expect(shared).toMatchObject({ id, status: 'pending_review', sharedVia: 'organization' });
    expect(Object.keys(shared!).sort()).toEqual(
      ['description', 'id', 'pin', 'sharedVia', 'slug', 'status', 'trustLabel', 'updatedAt'].sort()
    );
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
