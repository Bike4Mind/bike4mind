// @vitest-environment node
import { createMocks } from 'node-mocks-http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { PENDING_ACTION_TTL_MS, type Brief } from '@bike4mind/common';
import { AssistantBriefModel, Quest, Session } from '@bike4mind/database';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

vi.mock('@server/middlewares/defineNextRoute', () => ({
  nextRouteForContract: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: { method: string }, res: unknown) => handlers[req.method]?.(req, res),
      {
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({ perUserRateLimit: () => vi.fn() }));
// A custom-connector action is the approve path with the fewest external calls; the claim, the
// quest and the brief read are all real.
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpAccess', () => ({ assertCustomMcpEnabled: vi.fn() }));
vi.mock('@bike4mind/server-utils/mcpConnections/customMcpToolHost', () => ({
  isCustomToolStillOffered: vi.fn().mockResolvedValue(true),
  customMcpToolHost: { callTool: vi.fn().mockResolvedValue({ result: { isError: false } }) },
}));

import getBrief from '../[id]';
import approve from '../../pending-actions/[questId]/approve';
import deny from '../../pending-actions/[questId]/deny';

type Handler = (req: unknown, res: unknown) => Promise<void>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const userA = new mongoose.Types.ObjectId().toString();
const userB = new mongoose.Types.ObjectId().toString();

const call = async (handler: unknown, method: 'GET' | 'POST', userId: string, extra: Record<string, unknown>) => {
  const { req, res } = createMocks({ method });
  Object.assign(req, { user: { id: userId }, logger, ...extra });
  await (handler as Handler)(req, res);
  return res;
};

const fetchBrief = async (briefId: string, userId = userA) => {
  const res = await call(getBrief, 'GET', userId, { validatedParams: { id: briefId } });
  return { status: res._getStatusCode(), body: res._getJSONData() as Brief };
};

const decide = (handler: unknown, questId: string, pendingActionTs: number) =>
  call(handler, 'POST', userA, { validatedParams: { questId }, validated: { pendingActionTs } });

/** A session owned by user A with one quest waiting on approval, and a ready brief citing it. */
const seed = async (ts: number) => {
  const sessionId = new mongoose.Types.ObjectId();
  const questId = new mongoose.Types.ObjectId();
  await Session.collection.insertOne({ _id: sessionId, userId: userA, name: 'n' });
  await Quest.collection.insertOne({
    _id: questId,
    sessionId: sessionId.toString(),
    pendingAction: {
      tool: 'send_message',
      params: {},
      ts,
      customConnector: { connectionId: 'c1', slug: 's', displayName: 'Acme', urlHost: 'example.com' },
    },
  });
  const brief = await AssistantBriefModel.create({
    userId: userA,
    status: 'ready',
    periodStart: new Date(ts - 3_600_000),
    periodEnd: new Date(ts),
    composedAt: new Date(ts),
    decisions: [
      {
        id: 'd1',
        text: 'Send the message?',
        approval: { questId: questId.toString(), sessionId: sessionId.toString(), pendingActionTs: ts },
      },
    ],
  });
  return { briefId: brief._id.toString(), questId: questId.toString() };
};

const stateOf = async (briefId: string) => (await fetchBrief(briefId)).body.decisions[0].approval?.state;

describe('GET /api/v1/briefs/[id] approval state, driven through the real pending-action routes', () => {
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  it('reports pending, then approved after the approve route, and the second approve is a 409', async () => {
    const ts = Date.now() - 1000;
    const { briefId, questId } = await seed(ts);
    expect(await stateOf(briefId)).toBe('pending');

    expect((await decide(approve, questId, ts))._getStatusCode()).toBe(200);
    expect(await stateOf(briefId)).toBe('approved');

    const again = await decide(approve, questId, ts);
    expect(again._getStatusCode()).toBe(409);
    expect(await stateOf(briefId)).toBe('approved');
  });

  it('reports denied after the deny route', async () => {
    const ts = Date.now() - 1000;
    const { briefId, questId } = await seed(ts);

    expect((await decide(deny, questId, ts))._getStatusCode()).toBe(200);
    expect(await stateOf(briefId)).toBe('denied');
  });

  it('reports replaced once a newer action takes its place on the quest', async () => {
    const ts = Date.now() - 1000;
    const { briefId, questId } = await seed(ts);
    await Quest.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(questId) },
      { $set: { 'pendingAction.ts': ts + 1 } }
    );

    expect(await stateOf(briefId)).toBe('replaced');
  });

  it('reports lapsed once the action is past its TTL, and approving it then records lapsed', async () => {
    const ts = Date.now() - 1000;
    const { briefId, questId } = await seed(ts);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(ts + PENDING_ACTION_TTL_MS + 1000);
    expect(await stateOf(briefId)).toBe('lapsed');

    expect((await decide(approve, questId, ts))._getStatusCode()).toBe(409);
    expect(await stateOf(briefId)).toBe('lapsed');
  });

  it("is a 404 for another user's brief", async () => {
    const { briefId } = await seed(Date.now() - 1000);

    await expect(fetchBrief(briefId, userB)).rejects.toThrow('Brief not found');
  });
});
