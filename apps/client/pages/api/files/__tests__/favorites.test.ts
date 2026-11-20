import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Mocks = ReturnType<typeof createMocks>;
type Handler = (req: Mocks['req'], res: Mocks['res']) => unknown;
const mockRefs = vi.hoisted(() => ({ getHandler: null as null | Handler }));

vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { get: (fn: Handler) => Chain };
  const chain: Chain = {
    get: (fn: Handler) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const find = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ favoriteRepository: { find } }));

import '@pages/api/files/favorites';

describe('GET /api/files/favorites', () => {
  it("returns only the caller's file stars", async () => {
    find.mockResolvedValue([{ documentId: 'f1' }, { documentId: 'f2' }]);
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'user-a' } });

    await mockRefs.getHandler!(req, res);

    expect(find).toHaveBeenCalledWith({ userId: 'user-a', documentType: 'files' });
    expect(res._getJSONData()).toEqual({ fileIds: ['f1', 'f2'] });
  });
});
