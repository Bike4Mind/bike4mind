import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * POST /api/test/create-user is how the E2E harness and QA mint accounts on local/preview
 * stages. It can now mint an EMAILLESS account - the shape an OAuth signup with no
 * provider-verified email produces - which is otherwise unreachable without a DB write.
 * The gate that matters: an emailless user has no email for cleanup to key on, so its
 * username must carry the `-e2e` marker or it would leak past every sweep.
 */

const h = vi.hoisted(() => ({
  isE2EEnabled: vi.fn(() => true),
  createUser: vi.fn(),
  issueSessionForRequest: vi.fn(),
  sstSecret: { value: 'right-secret' } as { value: string } | undefined,
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'GET']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@server/utils/config', () => ({ isE2EEnabled: h.isE2EEnabled }));
vi.mock('@server/auth/issueSession', () => ({ issueSessionForRequest: h.issueSessionForRequest }));
vi.mock('sst', () => ({
  Resource: {
    get E2E_CLEANUP_SECRET() {
      return h.sstSecret;
    },
  },
}));
vi.mock('@bike4mind/database', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ userService: { createUser: h.createUser } }));
vi.mock('@bike4mind/common', () => ({ PREDEFINED_USER_TAGS: ['seed-tag'], CURRENT_POLICY_VERSION: '2026-01' }));

import handler from '../create-user';

const body = (over: Record<string, unknown> = {}) => ({
  username: 'qa-12345678-e2e',
  email: 'qa-12345678-e2e@test.com',
  name: 'QA',
  password: 'pw',
  ...over,
});

const makeReq = (over: Record<string, unknown> = {}) => ({
  method: 'POST',
  query: {},
  body: body(over),
  headers: { 'x-e2e-cleanup-secret': 'right-secret' },
});

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json, status };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.sstSecret = { value: 'right-secret' };
  delete process.env.E2E_CLEANUP_SECRET;
  h.isE2EEnabled.mockReturnValue(true);
  h.createUser.mockImplementation(async (params: { username: string }) => ({ id: 'u1', username: params.username }));
  h.issueSessionForRequest.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt' });
});

describe('POST /api/test/create-user', () => {
  it('still requires the -e2e@test.com pattern when an email is given', async () => {
    const { res, status } = makeRes();
    await handler(makeReq({ email: 'someone@example.com' }) as never, res);

    expect(status).toHaveBeenCalledWith(400);
    expect(h.createUser).not.toHaveBeenCalled();
  });

  describe('emailless account (no email in the body)', () => {
    it('refuses a username without the -e2e marker, since cleanup could never find it', async () => {
      const { res, status, json } = makeRes();
      await handler(makeReq({ email: undefined, username: 'qa-emailless' }) as never, res);

      expect(status).toHaveBeenCalledWith(400);
      expect(json).toHaveBeenCalledWith({ error: 'Emailless test users must use the -e2e username suffix' });
      expect(h.createUser).not.toHaveBeenCalled();
    });

    it.each([undefined, null])('creates the account with email null and nothing verified (email: %s)', async email => {
      const { res, status } = makeRes();
      await handler(makeReq({ email, username: 'qa-emailless-e2e' }) as never, res);

      expect(status).toHaveBeenCalledWith(201);
      const params = h.createUser.mock.calls[0][0];
      expect(params.username).toBe('qa-emailless-e2e');
      expect(params.email).toBeNull();
      expect(params.emailVerified).toBe(false);
    });

    it('ignores an explicit emailVerified: true when there is no email to have verified', async () => {
      const { res } = makeRes();
      await handler(makeReq({ email: null, username: 'qa-emailless-e2e', emailVerified: true }) as never, res);

      expect(h.createUser.mock.calls[0][0].emailVerified).toBe(false);
    });

    it('still issues a session, which is how the account is entered without a login code', async () => {
      const { res, json } = makeRes();
      await handler(makeReq({ email: null, username: 'qa-emailless-e2e' }) as never, res);

      expect(h.issueSessionForRequest).toHaveBeenCalledWith(expect.anything(), 'u1', expect.anything());
      expect(json).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'at', refreshToken: 'rt' }));
    });
  });
});
