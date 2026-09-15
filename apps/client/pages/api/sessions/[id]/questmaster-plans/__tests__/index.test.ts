import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The session lookup casts, so it resolves under any hex casing, but findByNotebookId
 * queries `notebookId: { type: String }` and does byte equality. Accepting an uppercase
 * id without canonicalizing it would turn a 400 into a silent, wrong `200 []`.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    post: () => chain,
    put: () => chain,
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const sessionRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const questMasterPlanRepository = vi.hoisted(() => ({ findByNotebookId: vi.fn() }));
vi.mock('@bike4mind/database', () => ({ sessionRepository, questMasterPlanRepository }));

import '@pages/api/sessions/[id]/questmaster-plans/index';

const SESSION_ID = '507f1f77bcf86cd799439011';
const USER_ID = 'user1';

const call = (id: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  (req as any).user = { id: USER_ID };
  return { res, result: mockRefs.getHandler!(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  sessionRepository.findById.mockResolvedValue({ id: SESSION_ID, userId: USER_ID });
  questMasterPlanRepository.findByNotebookId.mockResolvedValue([{ id: 'plan1' }]);
});

describe('GET /api/sessions/[id]/questmaster-plans', () => {
  it('returns the plans for a lowercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID);
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(questMasterPlanRepository.findByNotebookId).toHaveBeenCalledWith(SESSION_ID);
  });

  it('queries the canonical lowercase id for an uppercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID.toUpperCase());
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual([{ id: 'plan1' }]);
    expect(questMasterPlanRepository.findByNotebookId).toHaveBeenCalledWith(SESSION_ID);
  });

  it('rejects a session id that is not object-id shaped', async () => {
    const { res, result } = call('not-a-session-id');
    await result;

    expect(res._getStatusCode()).toBe(400);
    expect(sessionRepository.findById).not.toHaveBeenCalled();
  });
});
