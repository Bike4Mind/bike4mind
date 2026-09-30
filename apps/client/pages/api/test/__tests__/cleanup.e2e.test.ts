import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import {
  User,
  Session,
  Quest,
  FabFile,
  Agent,
  Project,
  Organization,
  Favorite,
  Artifact,
  Tool,
  DataLakeModel,
  DataLakeAccessGrantModel,
  DataLakeProposalModel,
  DataLakeResearchConfigModel,
  DataLakeResearchRunModel,
  DataLakeFindingModel,
  LakeMembershipDecisionModel,
  DataLakeCorpusActionModel,
  DataLakeOwnershipOfferModel,
} from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * DELETE /api/test/cleanup hard-deletes through the NATIVE driver (`Model.collection.deleteMany`) to
 * bypass the soft-delete plugin. The native driver does no schema casting, so every filter must
 * carry the value type the field actually stores - nearly every child collection stores the user
 * reference as `String`, and `Tool.userId` is the lone `ObjectId`. Passing ObjectIds where Strings
 * are stored deletes the User row and silently orphans everything else. This suite boots a real
 * mongod precisely because the bug only exists at the native-driver seam; a Mongoose-mocked test
 * would cast the values itself and pass on the broken code.
 */

type Handler = (req: unknown, res: unknown) => unknown;

const TEST_ID = 'e2ecleanup';
const SWEPT_EMAIL = `sweep-${TEST_ID}-12345678-e2e@test.com`;
const CONTROL_EMAIL = 'control-user-12345678@example.com';

const mockRefs = vi.hoisted(() => ({
  deleteHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    delete: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: () => true }));
vi.mock('sst', () => ({ Resource: { E2E_CLEANUP_SECRET: { value: 'right-secret' } } }));

let mongod: MongoMemoryServer;
let deleteHandler: Handler;

beforeAll(async () => {
  mongod = await createMongoServer();
  await mongoose.connect(mongod.getUri());
  await import('../cleanup');
  deleteHandler = mockRefs.deleteHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

afterEach(async () => {
  await mongoose.connection.dropDatabase();
});

const oid = () => new mongoose.Types.ObjectId();

// Native inserts, not `Model.create`: Mongoose validation is irrelevant to the query-value bug
// under test, and seeding only the fields cleanup filters on keeps the fixture readable.
const seedUser = async (email: string, username: string) => {
  const userId = oid();
  await User.collection.insertOne({ _id: userId, email, username });
  return userId;
};

const seedChildren = async (userId: mongoose.Types.ObjectId) => {
  const uid = userId.toString();
  const sessionId = oid();
  const lakeId = oid();

  await Session.collection.insertOne({ _id: sessionId, userId: uid, name: `s-${uid}` });
  await Quest.collection.insertOne({ _id: oid(), sessionId: sessionId.toString(), userId: uid, name: `q-${uid}` });
  await FabFile.collection.insertOne({ _id: oid(), userId: uid, fileName: `${uid}.txt` });
  await Agent.collection.insertOne({ _id: oid(), userId: uid, name: `a-${uid}` });
  await Project.collection.insertOne({ _id: oid(), userId: uid, name: `p-${uid}` });
  await Organization.collection.insertOne({ _id: oid(), userId: uid, name: `o-${uid}` });
  await Favorite.collection.insertOne({ _id: oid(), userId: uid, documentId: `d-${uid}` });
  await Artifact.collection.insertOne({ _id: oid(), userId: uid });
  // The one genuinely ObjectId-typed user reference - guards against over-correcting Tool to strings.
  await Tool.collection.insertOne({ _id: oid(), userId });
  // Activity keys ownership as ownerType/ownerId (both String), not userId, so it needs its own
  // filter - the generic `userId` delete is a no-op for it. Guards that dedicated filter.
  await mongoose.models.Activity.collection.insertOne({
    _id: oid(),
    key: `k-${uid}`,
    trackableType: 'User',
    trackableId: uid,
    ownerType: 'User',
    ownerId: uid,
    createdAt: new Date(),
  });
  await DataLakeModel.collection.insertOne({ _id: lakeId, createdByUserId: uid, name: `lake-${uid}` });
  await DataLakeAccessGrantModel.collection.insertOne({
    _id: oid(),
    dataLakeId: lakeId.toString(),
    principalType: 'user',
    principalId: uid,
    role: 'owner',
    grantedByUserId: uid,
  });
  // One row in every lake-keyed collection the cleanup sweeps. These are the dependents that would
  // be orphaned if the lake parent were hard-deleted first - cleanupDeletedDataLake cannot collect
  // them afterwards because it early-returns once the parent is gone.
  await DataLakeProposalModel.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString(), status: 'pending' });
  await mongoose.models.DataLakeBatch.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString(), userId: uid });
  await DataLakeResearchConfigModel.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString() });
  await DataLakeResearchRunModel.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString() });
  await DataLakeFindingModel.collection.insertOne({ _id: oid(), lakeId: lakeId.toString() });
  await LakeMembershipDecisionModel.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString() });
  await DataLakeCorpusActionModel.collection.insertOne({ _id: oid(), lakeId: lakeId.toString() });
  await DataLakeOwnershipOfferModel.collection.insertOne({ _id: oid(), dataLakeId: lakeId.toString() });

  return { sessionId, lakeId };
};

const callCleanup = async (query: Record<string, string>) => {
  const { req, res } = createMocks({ method: 'DELETE', query, headers: { 'x-e2e-cleanup-secret': 'right-secret' } });
  await deleteHandler(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() as Record<string, unknown> };
};

describe('DELETE /api/test/cleanup (real DB)', () => {
  it('deletes every String-keyed child row of the swept user, and the user itself', async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    const { sessionId } = await seedChildren(sweptUserId);
    const uid = sweptUserId.toString();

    const { status, body } = await callCleanup({ testId: TEST_ID });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(await User.collection.countDocuments({ _id: sweptUserId })).toBe(0);
    expect(await Session.collection.countDocuments({ userId: uid })).toBe(0);
    // Quest is deleted by its String sessionId, sourced from the Mongoose Session lookup.
    expect(await Quest.collection.countDocuments({ sessionId: sessionId.toString() })).toBe(0);
    expect(await Quest.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await FabFile.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Agent.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Project.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Organization.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Favorite.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Artifact.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await mongoose.models.Activity.collection.countDocuments({ ownerType: 'User', ownerId: uid })).toBe(0);
  });

  it('deletes quests of soft-deleted sessions, which the session hard-delete also removes', async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    const uid = sweptUserId.toString();
    const softSessionId = oid();
    // The native session delete bypasses the soft-delete plugin, so this row goes; its quest must
    // be collected from the same includeDeleted lookup or it is orphaned.
    await Session.collection.insertOne({ _id: softSessionId, userId: uid, name: `soft-${uid}`, deletedAt: new Date() });
    await Quest.collection.insertOne({
      _id: oid(),
      sessionId: softSessionId.toString(),
      userId: uid,
      name: `q-soft-${uid}`,
    });

    await callCleanup({ testId: TEST_ID });

    expect(await Session.collection.countDocuments({ userId: uid })).toBe(0);
    expect(await Quest.collection.countDocuments({ sessionId: softSessionId.toString() })).toBe(0);
  });

  it('deletes the ObjectId-keyed Tool row too', async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    await seedChildren(sweptUserId);

    await callCleanup({ testId: TEST_ID });

    expect(await Tool.collection.countDocuments({ userId: sweptUserId })).toBe(0);
  });

  it('reclaims a swept lake, its access grants, and every lake-keyed dependent', async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    const { lakeId } = await seedChildren(sweptUserId);
    const uid = sweptUserId.toString();
    const lakeIdString = lakeId.toString();

    const { body } = await callCleanup({ testId: TEST_ID });

    expect(await DataLakeModel.collection.countDocuments({ createdByUserId: uid })).toBe(0);
    expect(await DataLakeAccessGrantModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await DataLakeProposalModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await mongoose.models.DataLakeBatch.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await DataLakeResearchConfigModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await DataLakeResearchRunModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await DataLakeFindingModel.collection.countDocuments({ lakeId: lakeIdString })).toBe(0);
    expect(await LakeMembershipDecisionModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect(await DataLakeCorpusActionModel.collection.countDocuments({ lakeId: lakeIdString })).toBe(0);
    expect(await DataLakeOwnershipOfferModel.collection.countDocuments({ dataLakeId: lakeIdString })).toBe(0);
    expect((body.cleaned as Record<string, number>).dataLakes).toBe(1);
  });

  it("leaves a non-e2e user's rows untouched", async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    const controlUserId = await seedUser(CONTROL_EMAIL, 'control-user-12345678');
    await seedChildren(sweptUserId);
    const { lakeId: controlLakeId } = await seedChildren(controlUserId);
    const cuid = controlUserId.toString();

    await callCleanup({ testId: TEST_ID });

    expect(await User.collection.countDocuments({ _id: controlUserId })).toBe(1);
    expect(await Session.collection.countDocuments({ userId: cuid })).toBe(1);
    expect(await FabFile.collection.countDocuments({ userId: cuid })).toBe(1);
    expect(await mongoose.models.Activity.collection.countDocuments({ ownerType: 'User', ownerId: cuid })).toBe(1);
    expect(await DataLakeModel.collection.countDocuments({ createdByUserId: cuid })).toBe(1);
    expect(await DataLakeAccessGrantModel.collection.countDocuments({ dataLakeId: controlLakeId.toString() })).toBe(1);
    expect(await DataLakeProposalModel.collection.countDocuments({ dataLakeId: controlLakeId.toString() })).toBe(1);
    expect(await DataLakeFindingModel.collection.countDocuments({ lakeId: controlLakeId.toString() })).toBe(1);
  });

  it('warns when users were swept but no child rows were deleted', async () => {
    await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);

    const { body } = await callCleanup({ testId: TEST_ID });

    expect(typeof body.warning).toBe('string');
  });

  it('does not warn when child rows were deleted', async () => {
    const sweptUserId = await seedUser(SWEPT_EMAIL, `sweep-${TEST_ID}-12345678-e2e`);
    await seedChildren(sweptUserId);

    const { body } = await callCleanup({ testId: TEST_ID });

    expect(body.warning).toBeUndefined();
  });
});
