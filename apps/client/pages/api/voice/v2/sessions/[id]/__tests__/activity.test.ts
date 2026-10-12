import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { NotFoundError } from '@server/utils/errors';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  postHandler: null as null | RouteHandler,
  findByIdAndUserId: vi.fn(),
  recordVoiceActivity: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: RouteHandler) => {
      h.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  sessionRepository: { findByIdAndUserId: h.findByIdAndUserId, recordVoiceActivity: h.recordVoiceActivity },
}));

await import('../activity');

const SESSION_ID = '0123456789abcdef01234567';

const post = async (id: string) => {
  const { req, res } = createMocks({ method: 'POST', query: { id } });
  Object.assign(req, { user: { id: 'user-1' } });
  await h.postHandler!(req, res);
  return res;
};

describe('POST /api/voice/v2/sessions/{id}/activity', () => {
  beforeEach(() => vi.clearAllMocks());

  it("records activity on the caller's own session", async () => {
    h.findByIdAndUserId.mockResolvedValue({ id: SESSION_ID });

    const res = await post(SESSION_ID);

    expect(res._getStatusCode()).toBe(204);
    expect(h.findByIdAndUserId).toHaveBeenCalledWith(SESSION_ID, 'user-1');
    expect(h.recordVoiceActivity).toHaveBeenCalledWith(SESSION_ID, expect.any(Date));
  });

  it("refuses a session the caller doesn't own, without recording anything", async () => {
    h.findByIdAndUserId.mockResolvedValue(null);

    await expect(post(SESSION_ID)).rejects.toThrow(NotFoundError);
    expect(h.recordVoiceActivity).not.toHaveBeenCalled();
  });

  it('refuses a malformed id without querying', async () => {
    await expect(post('not-an-id')).rejects.toThrow(NotFoundError);
    expect(h.findByIdAndUserId).not.toHaveBeenCalled();
  });
});
