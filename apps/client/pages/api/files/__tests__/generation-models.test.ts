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

const listGenerationModelIds = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ fabFileRepository: { listGenerationModelIds } }));

import '@pages/api/files/generation-models';

describe('GET /api/files/generation-models', () => {
  it("lists the models behind the caller's own files", async () => {
    listGenerationModelIds.mockResolvedValue(['flux-pro', 'veo-3']);
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'user-a' } });

    await mockRefs.getHandler!(req, res);

    expect(listGenerationModelIds).toHaveBeenCalledWith('user-a');
    expect(res._getJSONData()).toEqual({ modelIds: ['flux-pro', 'veo-3'] });
  });
});
