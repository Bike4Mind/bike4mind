import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
    const chain = async (req: { method: string }, res: unknown) => handlers[req.method](req, res);
    chain.use = () => chain;
    chain.get = (fn: (typeof handlers)[string]) => {
      handlers.GET = fn;
      return chain;
    };
    return chain;
  },
}));

const mockLean = vi.fn();
vi.mock('@bike4mind/database', () => ({
  Quest: { find: () => ({ sort: () => ({ limit: () => ({ lean: () => mockLean() }) }) }) },
  cacheRepository: {},
}));

// Runs the loader directly so the 12h cache never hides the projection under test.
vi.mock('@bike4mind/services', () => ({
  cacheService: { getCachedData: (_key: string, loader: () => unknown) => loader() },
}));

import modelMetricsHandler from '../model-metrics';
import analyticsHandler from '../analytics';

const baseQuest = {
  timestamp: new Date('2026-01-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
  status: 'done',
};

const quests = [
  { ...baseQuest, _id: 'a', promptMeta: { model: { name: 'm' } }, clientFirstTokenTime: 250 },
  {
    ...baseQuest,
    _id: 'b',
    promptMeta: { model: { name: 'm' }, performance: { clientFirstTokenTime: 99 } },
  },
  { ...baseQuest, _id: 'c', promptMeta: { model: { name: 'm' } } },
];

async function call(handler: unknown) {
  const { req, res } = createMocks({ method: 'GET', query: {} });
  (req as unknown as { user: { isAdmin: boolean } }).user = { isAdmin: true };
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return res._getJSONData() as Array<{ performance: { clientFirstTokenTime?: number } }>;
}

describe('admin quest metrics clientFirstTokenTime', () => {
  beforeEach(() => {
    mockLean.mockResolvedValue(quests);
  });

  it.each([
    ['model-metrics', modelMetricsHandler],
    ['analytics', analyticsHandler],
  ])('%s prefers the quest-level value and falls back to the legacy promptMeta one', async (_name, handler) => {
    const rows = await call(handler);
    expect(rows.map(r => r.performance.clientFirstTokenTime)).toEqual([250, 99, undefined]);
  });
});
