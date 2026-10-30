import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { Quest } from '@bike4mind/database';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
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
  NotFoundError: class NotFoundError extends Error {
    name = 'NotFoundError';
  },
}));

import handler from '../[id]';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const run = (id: string, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin };
  return { req, res };
};

const createLog = () =>
  Quest.create({
    sessionId: 'session-1',
    type: 'message',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    prompt: 'hello',
    promptMeta: {
      session: { id: 'session-1', userId: 'user-2' },
      model: { name: 'claude-sonnet-5' },
      functionCalls: [
        {
          id: 'call-1',
          name: 'web_search',
          parameters: {},
          returnValue: 'private tool output',
          error: 'private tool error',
          success: true,
        },
      ],
      citables: [
        {
          id: 'file-1',
          type: 'document',
          title: 'Reference',
          metadata: { sourceSystem: 'knowledge_base', chunkId: 'chunk-1', fullContext: 'private passage' },
        },
      ],
    },
  });

describe('GET /api/admin/model-logs/[id]', () => {
  let mongoServer: MongoMemoryServer;

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

  it('returns the full promptMeta with owner-only tool output redacted', async () => {
    const quest = await createLog();
    const { req, res } = run(quest.id);
    await handler(req, res);

    const body = res._getJSONData();
    expect(body).toMatchObject({
      id: quest.id,
      timestamp: '2026-01-01T00:00:00.000Z',
      model: { name: 'claude-sonnet-5' },
      functionCalls: [expect.objectContaining({ name: 'web_search' })],
    });
    expect(JSON.stringify(body)).not.toContain('private tool output');
    expect(JSON.stringify(body)).not.toContain('private tool error');
    expect(JSON.stringify(body)).not.toContain('private passage');
    expect(body.citables[0]).toMatchObject({
      id: 'file-1',
      title: 'Reference',
      metadata: { sourceSystem: 'knowledge_base', chunkId: 'chunk-1' },
    });
  });

  it.each([
    ['an unknown id', () => new mongoose.Types.ObjectId().toString()],
    ['a malformed id', () => 'not-an-id'],
  ])('answers 404 for %s', async (_label, makeId) => {
    const { req, res } = run(makeId());
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects an empty id before any query runs', async () => {
    const findSpy = vi.spyOn(Quest, 'findById');
    const { req, res } = run('');
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'ZodError' });
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });

  it('answers 404 for a soft-deleted log', async () => {
    const quest = await createLog();
    await Quest.updateOne({ _id: quest._id }, { $set: { deletedAt: new Date() } });
    const { req, res } = run(quest.id);
    await expect(handler(req, res)).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('rejects a non-admin before reading the log', async () => {
    const quest = await createLog();
    const findSpy = vi.spyOn(Quest, 'findById');
    const { req, res } = run(quest.id, false);
    await expect(handler(req, res)).rejects.toThrow(/missing permission/i);
    expect(findSpy).not.toHaveBeenCalled();
    findSpy.mockRestore();
  });
});
