import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Session, Agent } from '@bike4mind/database';
import errorHandler from '@server/middlewares/errorHandler';

/**
 * The attach gate of POST /api/sessions/[id]/agents, driven against a real mongod and the REAL
 * `agentRepository.shareable.findAccessibleById` - nothing is mocked between the route and the
 * predicate's three arms (owner / users[] read-or-write / groups[] read-or-write).
 *
 * The route used to hand-roll `agent.users?.some(u => u.userId === req.user.id)`, which had no
 * groups arm (a group-shared agent was over-denied) and accepted a users[] entry carrying ANY
 * permissions, including none. Both halves of that move are pinned here. Stubbing the repository
 * would only pin that the route calls it, which is the one thing that cannot regress quietly.
 *
 * baseApi is captured rather than run: ../../__tests__/object-authz.integration.test.ts owns the
 * auth chain and the session-access gate that runs ahead of this one.
 */

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const CALLER = 'caller-1';
const OWNER = 'agent-owner';
const GROUP = 'group-alpha';
const OTHER_GROUP = 'group-beta';

const mockRefs = vi.hoisted(() => ({
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    use: () => chain,
    get: () => chain,
    delete: () => chain,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

let mongoServer: MongoMemoryServer;
let postAgents: (req: unknown, res: unknown) => unknown;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
  await import('../agents');
  postAgents = mockRefs.postHandler!;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

// Raw deletes, not dropDatabase() and not Model.deleteMany(): dropping the database discards the
// indexes too, so every test pays a fresh rebuild, and softDeletePlugin turns the Mongoose
// deleteMany static into a soft delete that leaves the rows in place.
afterEach(async () => {
  await Promise.all([Session.collection.deleteMany({}), Agent.collection.deleteMany({})]);
});

const stubLogger = () => {
  const logger: Record<string, unknown> = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  logger.withMetadata = vi.fn(() => logger);
  return logger;
};

/** A session the caller owns, so the write-level session gate ahead of the agent gate passes. */
const seedSession = async () => {
  const session = await Session.create({
    name: 'probe',
    userId: CALLER,
    lastUpdated: new Date(),
    firstCreated: new Date(),
  });
  return String(session._id);
};

type Share = { userId: string; permissions: string[] };
type GroupShare = { groupId: string; permissions: string[] };

let agentSeq = 0;

/** Agent.create, not insertOne: the scope discriminator lives in a pre-validate hook. */
const seedAgent = async (fields: { userId?: string; users?: Share[]; groups?: GroupShare[] }) => {
  const agent = await Agent.create({
    name: `agent-${++agentSeq}`,
    description: 'seeded',
    userId: OWNER,
    ...fields,
  });
  return String(agent._id);
};

/**
 * Raw insert, bypassing validation, for a share shape the schema enum will not admit - see the
 * `write` leg below. `deletedAt: null` is required: softDeletePlugin's pre-findOne hook narrows to
 * it, so a raw doc without the field is invisible to the predicate under test.
 */
const seedLegacyAgent = async (users: Share[]) => {
  const result = await Agent.collection.insertOne({
    name: `agent-${++agentSeq}`,
    description: 'seeded out-of-band',
    userId: OWNER,
    users,
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return String(result.insertedId);
};

const attach = async (sessionId: string, agentId: string, groups: string[] = []) => {
  const { req, res } = createMocks({ method: 'POST', query: { id: sessionId }, body: { agentId } });
  (req as unknown as { user: unknown }).user = { id: CALLER, groups };
  (req as unknown as { logger: unknown }).logger = stubLogger();
  (req as unknown as { requestId: string }).requestId = 'test-request-id';
  try {
    await postAgents(req, res);
  } catch (error) {
    errorHandler(error, req as Parameters<typeof errorHandler>[1], res as Parameters<typeof errorHandler>[2]);
  }
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

/** Raw collection read: what actually landed on the session, past any schema/redaction layer. */
const attachedAgentIds = async (sessionId: string): Promise<string[]> => {
  const raw = await Session.collection.findOne({ _id: new mongoose.Types.ObjectId(sessionId) });
  return (raw?.agentIds as string[] | undefined) ?? [];
};

describe('POST /api/sessions/[id]/agents attach gate', () => {
  it('attaches an agent the caller owns', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ userId: CALLER });

    const { status } = await attach(sessionId, agentId);

    expect(status).toBe(200);
    expect(await attachedAgentIds(sessionId)).toEqual([agentId]);
  });

  it('attaches a group-shared agent when the caller is in the granted group', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ groups: [{ groupId: GROUP, permissions: ['read'] }] });

    const { status } = await attach(sessionId, agentId, [GROUP]);

    // The arm the hand-rolled users[]-only predicate lacked: this used to 404.
    expect(status).toBe(200);
    expect(await attachedAgentIds(sessionId)).toEqual([agentId]);
  });

  it('denies a group-shared agent when the caller is in a different group', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ groups: [{ groupId: GROUP, permissions: ['read'] }] });

    const { status, body } = await attach(sessionId, agentId, [OTHER_GROUP]);

    expect(status).toBe(404);
    expect(body.error).toBe('Agent not found');
    expect(await attachedAgentIds(sessionId)).toEqual([]);
  });

  it('denies a group-shared agent whose grant carries no permissions', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ groups: [{ groupId: GROUP, permissions: [] }] });

    const { status, body } = await attach(sessionId, agentId, [GROUP]);

    expect(status).toBe(404);
    expect(body.error).toBe('Agent not found');
    expect(await attachedAgentIds(sessionId)).toEqual([]);
  });

  it('attaches a user-shared agent granted read', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ users: [{ userId: CALLER, permissions: ['read'] }] });

    const { status } = await attach(sessionId, agentId);

    expect(status).toBe(200);
    expect(await attachedAgentIds(sessionId)).toEqual([agentId]);
  });

  // The gate accepts read OR write, so the narrowing is "some grant", not "a read grant": what it
  // rejects is the permission-less entry below, not a non-read one. `write` is not in the
  // Permission enum and no app write path emits it, so this row can only be seeded out-of-band -
  // the arm is defensive against legacy data, exactly as the same arm on Organization is
  // (OrganizationModel.membershipOrgIds.test.ts). Pinned so a cleanup that drops `write` from the
  // `$in` has to decide about that data deliberately.
  it('attaches a user-shared agent carrying a legacy write grant', async () => {
    const sessionId = await seedSession();
    const agentId = await seedLegacyAgent([{ userId: CALLER, permissions: ['write'] }]);

    const { status } = await attach(sessionId, agentId);

    expect(status).toBe(200);
    expect(await attachedAgentIds(sessionId)).toEqual([agentId]);
  });

  it('denies a user-shared agent whose share carries no permissions', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({ users: [{ userId: CALLER, permissions: [] }] });

    const { status, body } = await attach(sessionId, agentId);

    expect(status).toBe(404);
    expect(body.error).toBe('Agent not found');
    expect(await attachedAgentIds(sessionId)).toEqual([]);
  });

  it('denies a foreign agent shared with nobody', async () => {
    const sessionId = await seedSession();
    const agentId = await seedAgent({});

    const { status, body } = await attach(sessionId, agentId);

    expect(status).toBe(404);
    expect(body.error).toBe('Agent not found');
    expect(await attachedAgentIds(sessionId)).toEqual([]);
  });

  // A forbidden agent, an absent one and an id that cannot address a row must be indistinguishable:
  // a differing status or body would make the route an oracle for other users' agent ids. The junk
  // id also pins findAccessibleById's ObjectId guard: without it the id reaches Mongo, and the
  // CastError comes back as 404 'Resource not found' - same status, different body, which is enough
  // to tell an unusable id from a real one.
  it('reports a forbidden, an absent and an unusable agent id identically', async () => {
    const sessionId = await seedSession();
    const forbidden = await attach(sessionId, await seedAgent({}));
    const absent = await attach(sessionId, new mongoose.Types.ObjectId().toString());
    const unusable = await attach(sessionId, 'agent-uuid-not-an-objectid');

    for (const result of [forbidden, absent, unusable]) {
      expect(result.status).toBe(404);
      expect(result.body.error).toBe('Agent not found');
    }
    expect(await attachedAgentIds(sessionId)).toEqual([]);
  });
});
