import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * The session lookup inside listFabFilesBySession casts, so it resolves under any hex
 * casing, but the chat-history query behind it hits `sessionId: { type: String }` and does
 * byte equality. The route has to hand the service the canonical lowercase id, or an
 * uppercase request silently returns a partial list instead of a 400.
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

const listFabFilesBySession = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ fabFilesService: { listFabFilesBySession } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  fabFileRepository: {},
  questRepository: {},
  sessionRepository: {},
  userRepository: {},
}));
vi.mock('@server/utils/storage', () => ({ getFilesStorage: () => ({ getSignedUrl: vi.fn() }) }));

import '@pages/api/sessions/[id]/files';

const SESSION_ID = '507f1f77bcf86cd799439011';

const call = (id?: string) => {
  const { req, res } = createMocks({ method: 'GET', query: id === undefined ? {} : { id } });
  (req as any).user = { id: 'user1' };
  return { res, result: mockRefs.getHandler!(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  listFabFilesBySession.mockResolvedValue([{ id: 'file1' }]);
});

describe('GET /api/sessions/[id]/files', () => {
  it('lists the files for a lowercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID);
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(listFabFilesBySession).toHaveBeenCalledWith('user1', { sessionId: SESSION_ID }, expect.anything());
  });

  it('passes the canonical lowercase id on for an uppercase-hex session id', async () => {
    const { res, result } = call(SESSION_ID.toUpperCase());
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(listFabFilesBySession).toHaveBeenCalledWith('user1', { sessionId: SESSION_ID }, expect.anything());
  });

  it('rejects a missing or malformed session id', async () => {
    const malformed = call('not-a-session-id');
    await malformed.result;
    expect(malformed.res._getStatusCode()).toBe(400);

    const missing = call();
    await missing.result;
    expect(missing.res._getStatusCode()).toBe(400);

    expect(listFabFilesBySession).not.toHaveBeenCalled();
  });
});
