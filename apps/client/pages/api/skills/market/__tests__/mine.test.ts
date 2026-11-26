import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  listMyListings: vi.fn(),
  templateSummaries: vi.fn(),
}));

vi.mock('@client/server/middlewares/baseApi', () => ({
  baseApi: () => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const fn = (async (req: { method: string }, res: unknown) => handlers[req.method](req, res)) as ((
      req: unknown,
      res: unknown
    ) => unknown) &
      Record<string, (h: unknown) => unknown>;
    fn.get = (handler: unknown) => ((handlers.GET = handler as never), fn);
    return fn;
  },
}));
vi.mock('@bike4mind/server-utils/skillMarket/market', () => ({
  serializeListing: (listing: { id: string; name: string }) => ({ id: listing.id, name: listing.name }),
}));
vi.mock('@server/skillMarket/author', () => ({ listMyListings: h.listMyListings }));
vi.mock('@server/skillMarket/template', () => ({ templateSummariesByListing: h.templateSummaries }));

import handler from '@pages/api/skills/market/mine';

const call = async () => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as { user: object }).user = { id: 'author-1' };
  await (handler as unknown as (a: unknown, b: unknown) => Promise<unknown>)(req, res);
  return res._getJSONData() as { data: Array<Record<string, unknown>> };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/skills/market/mine', () => {
  it("adds each listing's template summary from one batched lookup", async () => {
    h.listMyListings.mockResolvedValue({
      listings: [
        { listing: { id: 'l1', name: 'one' }, versions: [] },
        { listing: { id: 'l2', name: 'two' }, versions: [] },
      ],
    });
    h.templateSummaries.mockResolvedValue(new Map([['l1', { slug: 'one', status: 'published' }]]));

    const { data } = await call();

    expect(h.templateSummaries).toHaveBeenCalledTimes(1);
    expect(h.templateSummaries).toHaveBeenCalledWith(['l1', 'l2']);
    expect(data).toEqual([
      { id: 'l1', name: 'one', versions: [], template: { slug: 'one', status: 'published' } },
      { id: 'l2', name: 'two', versions: [], template: null },
    ]);
  });
});
