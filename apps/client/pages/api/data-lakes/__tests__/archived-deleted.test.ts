import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  listArchivedDataLakes: vi.fn(),
  listDeletedDataLakes: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    let route: ((req: unknown, res: unknown) => unknown) | undefined;
    const chain = Object.assign((req: unknown, res: unknown) => route?.(req, res), {
      use: () => chain,
      get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((route = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: h.toAccessContext }));
vi.mock('@bike4mind/services', () => ({
  dataLakeService: {
    listArchivedDataLakes: h.listArchivedDataLakes,
    listDeletedDataLakes: h.listDeletedDataLakes,
  },
}));

import archivedHandler from '../archived';
import deletedHandler from '../deleted';

const makeRes = () => {
  const json = vi.fn();
  return { res: { json, status: vi.fn(() => ({ json })) } as never, json };
};
type Handler = (req: unknown, res: unknown) => Promise<void>;

describe.each([
  { route: 'archived', handler: archivedHandler as Handler, list: h.listArchivedDataLakes },
  { route: 'deleted', handler: deletedHandler as Handler, list: h.listDeletedDataLakes },
])('GET /api/data-lakes/$route', ({ handler, list }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.toAccessContext.mockResolvedValue({ userId: 'u1', isAdmin: false, userTags: [] });
  });

  it('returns each lake through the response schema, stripping undeclared keys', async () => {
    list.mockResolvedValue([
      { id: 'lake1', name: 'Docs', systemPrompt: 'editor only', _id: 'raw-object-id', __v: 2 },
      { id: 'lake2', name: 'Reader view', notInSchema: 'secret' },
    ]);
    const { res, json } = makeRes();

    await handler({ method: 'GET', user: { id: 'u1' } }, res);

    expect(json).toHaveBeenCalledWith({
      data: [
        { id: 'lake1', name: 'Docs', systemPrompt: 'editor only' },
        { id: 'lake2', name: 'Reader view' },
      ],
    });
  });
});
