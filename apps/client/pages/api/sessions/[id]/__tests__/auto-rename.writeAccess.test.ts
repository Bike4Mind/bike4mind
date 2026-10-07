/**
 * autoName's write re-checks the caller's update access, so a revoke or delete during the LLM call
 * surfaces as NotFoundError. The route's catch-all remaps errors to a 500; this one must pass through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { InternalServerError, NotFoundError } from '@bike4mind/utils';

type RouteHandler = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({ postHandler: null as null | RouteHandler, autoName: vi.fn() }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    post: (fn: RouteHandler) => {
      h.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/utils/sessionAccess', () => ({ assertSessionAccess: vi.fn() }));
vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn(async () => ({ modelId: 'm', llm: {} })) },
}));
vi.mock('@bike4mind/services', () => ({ sessionService: { autoName: h.autoName } }));
vi.mock('@bike4mind/database', () => ({ questRepository: {}, sessionRepository: {} }));

await import('../auto-rename');

const call = () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'session-1' } });
  const user = { id: 'user-sharee', groups: [] };
  Object.assign(req, { user, logger: { error: vi.fn() } });
  return { run: () => h.postHandler!(req, res), user };
};

describe('POST /api/sessions/[id]/auto-rename write-time re-check', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the caller to autoName so its write is gated on them', async () => {
    h.autoName.mockResolvedValue({ id: 'session-1', name: 'New' });
    const { run, user } = call();

    await run();

    expect(h.autoName).toHaveBeenCalledWith({ sessionId: 'session-1' }, expect.anything(), user);
  });

  it('answers 404, not 500, when the gated write refused a caller revoked mid-call', async () => {
    h.autoName.mockRejectedValue(new NotFoundError('Session not found'));

    await expect(call().run()).rejects.toThrow(NotFoundError);
  });

  it('still remaps an unexpected failure to a 500', async () => {
    h.autoName.mockRejectedValue(new Error('boom'));

    await expect(call().run()).rejects.toThrow(InternalServerError);
  });
});
