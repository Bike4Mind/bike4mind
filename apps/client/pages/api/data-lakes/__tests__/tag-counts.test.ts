// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolveAccessibleLakes, mockQueryDataLakeTagCounts, mockQueryScopedDataLakeTagCounts } = vi.hoisted(() => ({
  mockResolveAccessibleLakes: vi.fn(),
  mockQueryDataLakeTagCounts: vi.fn(),
  mockQueryScopedDataLakeTagCounts: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.get = (fn: unknown) => fn;
    return chain;
  },
}));
vi.mock('@server/dataLakes', () => ({
  resolveAccessibleLakes: mockResolveAccessibleLakes,
  queryDataLakeTagCounts: mockQueryDataLakeTagCounts,
  queryScopedDataLakeTagCounts: mockQueryScopedDataLakeTagCounts,
}));

import handler from '@pages/api/data-lakes/tag-counts';

type RouteHandler = (req: unknown, res: unknown) => Promise<unknown>;
const route = handler as unknown as RouteHandler;

const LAKES = [
  { id: 'lake1', datalakeTag: 'datalake:lake1' },
  { id: 'lake2', datalakeTag: 'datalake:lake2' },
];

const call = async (query: Record<string, unknown>) => {
  const req = { query, user: { id: 'u1' } };
  const json = vi.fn();
  await route(req, { json });
  return { req, json };
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveAccessibleLakes.mockResolvedValue(LAKES);
  mockQueryDataLakeTagCounts.mockResolvedValue({ tagCounts: [], totalLakeFileCount: 0 });
  mockQueryScopedDataLakeTagCounts.mockResolvedValue({ tagCounts: [{ tag: 'docs:alpha', count: 1 }] });
});

describe('GET /api/data-lakes/tag-counts', () => {
  it('serves the all-lakes payload when no lakeId is given', async () => {
    const { req, json } = await call({});

    expect(mockQueryDataLakeTagCounts).toHaveBeenCalledWith(req, LAKES);
    expect(mockQueryScopedDataLakeTagCounts).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ tagCounts: [], totalLakeFileCount: 0 });
  });

  it('scopes to a single lakeId against the server-resolved lakes', async () => {
    const { req, json } = await call({ lakeId: 'lake1' });

    expect(mockQueryScopedDataLakeTagCounts).toHaveBeenCalledWith(req, LAKES, ['lake1']);
    expect(mockQueryDataLakeTagCounts).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith({ tagCounts: [{ tag: 'docs:alpha', count: 1 }] });
  });

  it('accepts a repeated lakeId', async () => {
    const { req } = await call({ lakeId: ['lake1', 'lake2'] });

    expect(mockQueryScopedDataLakeTagCounts).toHaveBeenCalledWith(req, LAKES, ['lake1', 'lake2']);
  });

  it('stays scoped (to nothing) for an empty or malformed lakeId rather than widening to every lake', async () => {
    const { req } = await call({ lakeId: ['', { nested: 'x' }] });

    expect(mockQueryScopedDataLakeTagCounts).toHaveBeenCalledWith(req, LAKES, []);
    expect(mockQueryDataLakeTagCounts).not.toHaveBeenCalled();
  });
});
