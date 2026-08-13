import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
// createMongoServer is not exported from the package barrel / dist; deep-import the source
// (same convention as apps/client's other e2e/integration tests against a real Mongo).
import { createMongoServer } from '../../../../../../packages/database/src/__test__/createMongoServer';
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

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

import handler from '../model-logs';

const run = (query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as Record<string, unknown>).user = { id: 'admin1', isAdmin: true };
  return { req, res };
};

describe('GET /api/admin/model-logs', () => {
  let mongoServer: MongoMemoryServer;

  beforeEach(async () => {
    mongoServer = await createMongoServer();
    await mongoose.connect(mongoServer.getUri());

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
        executionTracking: {
          steps: [{ name: 'search_knowledge_base', status: 'completed', result: 'found the golden retriever facts' }],
        },
      },
    });

    // Deliberately seeds systemPrompt/userPrompt with the search term, to prove the route no
    // longer matches on them now that those two dead $or arms are dropped - they are never
    // persisted by the real write path, but the schema still admits a direct write like this.
    await Quest.create({
      sessionId: 'session-3',
      type: 'message',
      timestamp: new Date(),
      prompt: 'hey',
      promptMeta: {
        session: { id: 'session-3', userId: 'user-1' },
        model: { name: 'grok-3' },
        context: { systemPrompt: 'golden retriever facts', userPrompt: 'golden retriever facts' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any, // any: fixture deliberately writes fields the PromptMeta type excludes.
    });
  });

  afterEach(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
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

  it('matches on an executionTracking.steps result via $elemMatch', async () => {
    const { req, res } = run({ search: 'golden retriever' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(JSON.stringify(body.logs)).toContain('gpt-4o');
  });

  it('does not match on context.systemPrompt/userPrompt (dead arms dropped, not fixed)', async () => {
    const { req, res } = run({ search: 'golden retriever' });
    await handler(req, res);
    const body = res._getJSONData();
    expect(JSON.stringify(body.logs)).not.toContain('grok-3');
  });
});
