import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source
// (same convention as apps/client's other e2e/integration tests against a real Mongo).
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';

// This route's fix is a MongoDB query-semantics question (does $elemMatch actually match an
// array-of-objects field, does a dropped $or arm actually stop matching), which the directory's
// usual vi.mock('@bike4mind/database') convention can't verify - a mock only proves the JS
// wiring, not that the query matches in real Mongo. So this test deliberately uses a real
// createMongoServer()-backed instance instead.

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {
    name = 'ForbiddenError';
  },
}));

import handler, { MODEL_LOGS_MAX_LIMIT } from '../model-logs';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const run = (query: Record<string, string> = {}, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin };
  return { req, res };
};

describe('GET /api/admin/model-logs', () => {
  let mongoServer: MongoMemoryServer;

  // One mongod for the file, data isolation per test via dropDatabase below - booting a server
  // per test spent most of the budget on startup. init() settles the background autoIndex build
  // before any hook can drop the database out from under it (see createMongoServer).
  beforeAll(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());
    await Quest.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  afterEach(async () => {
    await mongoose.connection.dropDatabase();
  });

  beforeEach(async () => {
    await Quest.create({
      sessionId: 'session-1',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hello',
      promptMeta: { session: { id: 'session-1', userId: 'user-1' }, model: { name: 'claude-opus-5' } },
    });

    await Quest.create({
      sessionId: 'session-2',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hi',
      promptMeta: {
        session: { id: 'session-2', userId: 'user-1' },
        model: { name: 'gpt-4o' },
        // Only `name` is ever written by the real path (result/error are declared but unwritten -
        // see the route's own comment), so the fixture searches on name, not result/error.
        executionTracking: {
          steps: [{ name: 'search_knowledge_base_golden_retriever', status: 'completed' }],
        },
      },
    });

    await Quest.create({
      sessionId: 'session-3',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hey',
      promptMeta: { session: { id: 'session-3', userId: 'user-1' }, model: { name: 'llama-3' } },
    });

    // Deliberately seeds systemPrompt/userPrompt with the search term, to prove the route no
    // longer matches on them now that those two dead $or arms are dropped - they are never
    // persisted by the real write path, but the schema still admits a direct write like this.
    await Quest.create({
      sessionId: 'session-4',
      type: 'message',
      timestamp: new Date(),
      prompt: 'yo',
      promptMeta: {
        session: { id: 'session-4', userId: 'user-1' },
        model: { name: 'grok-3' },
        context: { systemPrompt: 'golden retriever facts', userPrompt: 'golden retriever facts' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, // any: fixture deliberately writes fields the PromptMeta type excludes.
    });

    // promptMeta.prompt IS a real, always-persisted field - replaces the dropped userPrompt arm's
    // search intent without the leak risk.
    await Quest.create({
      sessionId: 'session-5',
      type: 'message',
      timestamp: new Date(),
      prompt: 'yep',
      promptMeta: {
        session: { id: 'session-5', userId: 'user-1' },
        model: { name: 'gemini-2.5-flash' },
        prompt: 'what breed makes a good golden retriever companion?',
      },
    });

    // functionCalls[].returnValue is verbatim tool output (private corpus chunks, file contents);
    // the list must not carry it at all, and the detail route redacts it.
    await Quest.create({
      sessionId: 'session-6',
      type: 'message',
      timestamp: new Date(),
      prompt: 'yeah',
      promptMeta: {
        session: { id: 'session-6', userId: 'user-2' },
        model: { name: 'claude-sonnet-5' },
        functionCalls: [
          { id: 'call-1', name: 'web_search', parameters: {}, returnValue: 'private tool output', success: true },
        ],
      },
    });
  });

  it('matches on promptMeta.model.name', async () => {
    const { req, res } = run({ search: 'claude-opus-5' });
    await handler(req, res);
    const body = res._getJSONData();
    // The route spreads a hydrated (non-lean) Mongoose subdocument, whose exact serialized shape
    // is a pre-existing quirk unrelated to this fix - assert on content/count, not path shape.
    expect(body.total).toBe(1);
    expect(JSON.stringify(body.logs)).toContain('claude-opus-5');
  });

  it('matches on an executionTracking.steps name via $elemMatch', async () => {
    const { req, res } = run({ search: 'search_knowledge_base_golden_retriever' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(JSON.stringify(body.logs)).toContain('gpt-4o');
  });

  it('matches on promptMeta.prompt, replacing the dropped userPrompt arm intent', async () => {
    const { req, res } = run({ search: 'golden retriever companion' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(JSON.stringify(body.logs)).toContain('gemini-2.5-flash');
  });

  it('does not match on context.systemPrompt/userPrompt (dead arms dropped, not fixed)', async () => {
    const { req, res } = run({ search: 'golden retriever facts' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(0);
    expect(JSON.stringify(body.logs)).not.toContain('grok-3');
  });

  it('projects only the card fields, never the full promptMeta', async () => {
    const { req, res } = run({ search: 'claude-sonnet-5' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(1);
    const serialized = JSON.stringify(body.logs);
    expect(serialized).not.toContain('private tool output');
    expect(serialized).not.toContain('web_search');
    expect(Object.keys(body.logs[0]).sort()).toEqual(
      ['artifacts', 'attachedFileCount', 'completedStepCount', 'failedStepCount', 'id', 'modelName', 'timestamp'].sort()
    );
  });

  it('derives the card counts and artifact previews in the projection', async () => {
    await Quest.create({
      sessionId: 'session-7',
      type: 'message',
      timestamp: new Date(),
      prompt: 'counts',
      promptMeta: {
        session: { id: 'session-7', userId: 'user-1' },
        model: { name: 'counted-model' },
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        performance: { totalResponseTime: 1234 },
        context: {
          messageHistoryLength: 4,
          attachedFiles: [
            { name: 'a.txt', type: 'text', size: 1 },
            { name: 'b.txt', type: 'text', size: 1 },
          ],
        },
        executionTracking: { completedSteps: ['a', 'b', 'c'], failedSteps: ['d'] },
        artifacts: [{ type: 'html', content: 'x'.repeat(500) }],
      },
    });

    const { req, res } = run({ model: 'counted-model' });
    await handler(req, res);
    const [log] = res._getJSONData().logs;
    expect(log).toMatchObject({
      modelName: 'counted-model',
      inputTokens: 10,
      outputTokens: 20,
      totalResponseTime: 1234,
      messageHistoryLength: 4,
      attachedFileCount: 2,
      completedStepCount: 3,
      failedStepCount: 1,
      artifacts: [{ type: 'html', preview: 'x'.repeat(100) }],
    });
  });

  it('pages newest first, with total counting every match', async () => {
    await Quest.updateMany({}, { $set: { timestamp: new Date('2026-01-01T00:00:00Z') } });
    await Quest.updateOne({ sessionId: 'session-1' }, { $set: { timestamp: new Date('2026-01-03T00:00:00Z') } });
    await Quest.updateOne({ sessionId: 'session-2' }, { $set: { timestamp: new Date('2026-01-02T00:00:00Z') } });

    const first = run({ page: '1', limit: '2' });
    await handler(first.req, first.res);
    const firstBody = first.res._getJSONData();
    expect(firstBody).toMatchObject({ total: 6, page: 1, limit: 2 });
    expect(firstBody.logs.map((log: { modelName: string }) => log.modelName)).toEqual(['claude-opus-5', 'gpt-4o']);

    const last = run({ page: '3', limit: '2' });
    await handler(last.req, last.res);
    const lastBody = last.res._getJSONData();
    expect(lastBody).toMatchObject({ total: 6, page: 3, limit: 2 });
    expect(lastBody.logs).toHaveLength(2);

    const past = run({ page: '4', limit: '2' });
    await handler(past.req, past.res);
    expect(past.res._getJSONData()).toMatchObject({ logs: [], total: 6 });
  });

  it('keeps tied timestamps in a stable order across independently fetched pages', async () => {
    const identifiers = Array.from(
      { length: 30 },
      (_, index) => new mongoose.Types.ObjectId((index + 1).toString(16).padStart(24, '0'))
    );
    await Quest.insertMany(
      identifiers.map(_id => ({
        _id,
        sessionId: 'tied-timestamps',
        type: 'message',
        timestamp: new Date('2026-01-01T00:00:00Z'),
        promptMeta: {
          session: { id: 'tied-timestamps', userId: 'user-1' },
          model: { name: 'tied-model' },
        },
      }))
    );

    const pages = await Promise.all(
      [1, 2, 3].map(async page => {
        const { req, res } = run({ model: 'tied-model', page: String(page), limit: '10' });
        await handler(req, res);
        return res._getJSONData().logs as { id: string }[];
      })
    );
    expect(pages.flat().map(log => log.id)).toEqual([...identifiers].reverse().map(id => id.toString()));
  });

  it('defaults page and limit and clamps an oversized limit', async () => {
    const defaults = run();
    await handler(defaults.req, defaults.res);
    expect(defaults.res._getJSONData()).toMatchObject({ page: 1, limit: 25, total: 6 });

    const oversized = run({ limit: '5000' });
    await handler(oversized.req, oversized.res);
    expect(oversized.res._getJSONData().limit).toBe(MODEL_LOGS_MAX_LIMIT);
  });

  it('leaves soft-deleted logs out of both the page and the total', async () => {
    await Quest.updateOne({ sessionId: 'session-1' }, { $set: { deletedAt: new Date() } });
    const { req, res } = run();
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(5);
    expect(JSON.stringify(body.logs)).not.toContain('claude-opus-5');
  });

  it.each([
    ['page', '0'],
    ['page', 'abc'],
    ['page', '1.5'],
    ['limit', '0'],
    ['limit', '-1'],
    ['limit', 'abc'],
    ['page', '10001'],
  ])('rejects %s=%s before any query runs', async (param, value) => {
    const aggregateSpy = vi.spyOn(Quest, 'aggregate');
    const { req, res } = run({ [param]: value });
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(aggregateSpy).not.toHaveBeenCalled();
    aggregateSpy.mockRestore();
  });
  // A bare z.string() let an unparseable value become an Invalid Date and cast against the
  // Date-typed `timestamp` filter, which surfaces as a 500 rather than answering the caller.
  it.each(['startDate', 'endDate'])('rejects an unparseable %s before any query runs', async param => {
    const querySpy = vi.spyOn(Quest, 'aggregate');
    const { req, res } = run({ [param]: 'not-a-date' });
    // Pin that it failed at schema parse (errorHandler maps a ZodError to 422). A bare
    // Error would still fail the request but would come back as a 500.
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(querySpy).not.toHaveBeenCalled();
    querySpy.mockRestore();
  });

  it('rejects a non-admin before any query runs', async () => {
    const aggregateSpy = vi.spyOn(Quest, 'aggregate');
    const countSpy = vi.spyOn(Quest, 'countDocuments');
    const { req, res } = run({}, false);
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ForbiddenError' });
    expect(aggregateSpy).not.toHaveBeenCalled();
    expect(countSpy).not.toHaveBeenCalled();
    aggregateSpy.mockRestore();
    countSpy.mockRestore();
  });

  it('answers an empty page and a zero total when nothing matches', async () => {
    const { req, res } = run({ model: 'no-such-model' });
    await handler(req, res);
    expect(res._getJSONData()).toMatchObject({ logs: [], total: 0, page: 1 });
  });

  it('includes the whole end day for a date-only endDate', async () => {
    await Quest.updateMany({}, { $set: { timestamp: new Date('2026-01-01T00:00:00Z') } });
    await Quest.updateOne({ sessionId: 'session-1' }, { $set: { timestamp: new Date('2026-01-02T23:59:59Z') } });
    await Quest.updateOne({ sessionId: 'session-2' }, { $set: { timestamp: new Date('2026-01-03T00:00:00Z') } });

    const { req, res } = run({ startDate: '2026-01-02', endDate: '2026-01-02' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(body.logs[0].modelName).toBe('claude-opus-5');
  });

  it('keeps an endDate with a time as an inclusive instant', async () => {
    await Quest.updateMany({}, { $set: { timestamp: new Date('2026-01-01T00:00:00Z') } });
    await Quest.updateOne({ sessionId: 'session-1' }, { $set: { timestamp: new Date('2026-01-02T12:00:00Z') } });

    const { req, res } = run({ startDate: '2026-01-02', endDate: '2026-01-02T12:00:00.000Z' });
    await handler(req, res);
    expect(res._getJSONData().total).toBe(1);

    const before = run({ endDate: '2026-01-02T11:59:59.999Z' });
    await handler(before.req, before.res);
    expect(before.res._getJSONData().total).toBe(5);
  });

  it('still accepts an empty date param, which the handler skips', async () => {
    const { req, res } = run({ startDate: '' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });

  it('still accepts a parseable startDate', async () => {
    const { req, res } = run({ startDate: '2000-01-01T00:00:00.000Z' });
    await handler(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
});
