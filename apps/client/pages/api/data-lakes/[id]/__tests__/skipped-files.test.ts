import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  listByLake: vi.fn(),
  countByLake: vi.fn(),
  toAccessContext: vi.fn(async () => ({ userId: 'u1', isAdmin: false })),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = Object.assign(() => undefined, {
      use: () => chain,
      get: (fn: unknown) => fn,
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({
  requireFeatureEnabled: () => (_req: unknown, _res: unknown, next: () => unknown) => next(),
}));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeWriteAccess: h.assertLakeWriteAccess },
}));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  lakeSkippedFileRepository: { listByLake: h.listByLake, countByLake: h.countByLake },
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));

import handler from '../skipped-files';

const route = handler as unknown as (req: unknown, res: unknown) => Promise<void>;

const invoke = async (query: Record<string, unknown> = {}) => {
  const json = vi.fn();
  await route({ method: 'GET', query: { id: 'lake-slug', ...query }, user: { id: 'u1' } }, { json });
  return json.mock.calls[0]?.[0];
};

const row = (sourceId: string) => ({
  id: `row-${sourceId}`,
  dataLakeId: 'lakeDoc1',
  sourceKind: 'google_drive',
  sourceId,
  name: `${sourceId}.pdf`,
  relativePath: `docs/${sourceId}.pdf`,
  size: 42,
  reason: 'storage_limit',
  firstSeenAt: new Date('2026-10-01T00:00:00Z'),
  lastSeenAt: new Date('2026-10-02T00:00:00Z'),
  createdAt: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  h.assertLakeWriteAccess.mockResolvedValue({ id: 'lakeDoc1' });
  h.listByLake.mockResolvedValue([]);
  h.countByLake.mockResolvedValue(0);
});

describe('GET /api/data-lakes/[id]/skipped-files', () => {
  it('is manage-gated and reads nothing when the gate refuses', async () => {
    h.assertLakeWriteAccess.mockRejectedValue(new Error('denied'));

    await expect(invoke()).rejects.toThrow('denied');
    expect(h.assertLakeWriteAccess.mock.calls[0][0]).toBe('lake-slug');
    expect(h.listByLake).not.toHaveBeenCalled();
    expect(h.countByLake).not.toHaveBeenCalled();
  });

  it('pages against the resolved lake id and reports the full total', async () => {
    h.listByLake.mockResolvedValue([row('a'), row('b')]);
    h.countByLake.mockResolvedValue(5);

    const body = await invoke({ limit: '2', offset: '2' });

    expect(h.listByLake).toHaveBeenCalledWith('lakeDoc1', { limit: 2, offset: 2 });
    expect(h.countByLake).toHaveBeenCalledWith('lakeDoc1');
    expect(body.total).toBe(5);
    expect(body.hasMore).toBe(true);
    expect(body.data[0]).toEqual({
      id: 'row-a',
      sourceKind: 'google_drive',
      sourceId: 'a',
      name: 'a.pdf',
      relativePath: 'docs/a.pdf',
      mimeType: undefined,
      size: 42,
      reason: 'storage_limit',
      firstSeenAt: '2026-10-01T00:00:00.000Z',
      lastSeenAt: '2026-10-02T00:00:00.000Z',
    });
  });

  it('reports no more rows once the page reaches the total', async () => {
    h.listByLake.mockResolvedValue([row('a')]);
    h.countByLake.mockResolvedValue(3);

    const body = await invoke({ limit: '2', offset: '2' });

    expect(body.hasMore).toBe(false);
  });

  it('defaults to the first page of 50', async () => {
    await invoke();
    expect(h.listByLake).toHaveBeenCalledWith('lakeDoc1', { limit: 50, offset: 0 });
  });

  it('rejects an out-of-range or repeated limit', async () => {
    await expect(invoke({ limit: '500' })).rejects.toThrow();
    await expect(invoke({ limit: ['10', '20'] })).rejects.toThrow();
  });
});
