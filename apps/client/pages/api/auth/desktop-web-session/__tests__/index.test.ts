// @vitest-environment node
/** POST /api/auth/desktop-web-session: Desktop trades its own Bearer session for a single-use code. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

const h = vi.hoisted(() => ({
  route: undefined as ((req: unknown, res: unknown) => unknown) | undefined,
  baseApiOptions: undefined as unknown,
  admitsOptionalAuthSession: vi.fn(),
  mintDesktopWebSessionCode: vi.fn(),
  findBySid: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    h.baseApiOptions = options;
    const chain: Record<string, unknown> = {};
    chain.use = () => chain;
    chain.post = (fn: (req: unknown, res: unknown) => unknown) => ((h.route = fn), chain);
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@bike4mind/database', () => ({ authSessionRepository: { findBySid: h.findBySid } }));
vi.mock('@server/middlewares/oauthRouteGate', () => ({ admitsOptionalAuthSession: h.admitsOptionalAuthSession }));
vi.mock('@server/auth/desktopWebSession', () => ({
  DESKTOP_WEB_SESSION_CODE_TTL_SECONDS: 60,
  mintDesktopWebSessionCode: h.mintDesktopWebSessionCode,
}));

await import('../index');

const USER = { id: '64b000000000000000000001', sid: 'desktop-sid' };

async function run(user: unknown) {
  const { req, res } = createMocks({ method: 'POST' });
  Object.assign(req, { user });
  await h.route!(req, res);
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.admitsOptionalAuthSession.mockResolvedValue(true);
  h.mintDesktopWebSessionCode.mockResolvedValue('minted-code');
  h.findBySid.mockResolvedValue({ sid: USER.sid, clientId: 'b4m-desktop', createdVia: 'device' });
});

describe('POST /api/auth/desktop-web-session', () => {
  it('accepts only a JWT, never an API key, and only POST', () => {
    expect(h.baseApiOptions).toMatchObject({ auth: 'jwtOnly', allowedMethods: ['POST'] });
  });

  it('returns a code bound to the caller and its session, uncached', async () => {
    const res = await run(USER);

    expect(res.statusCode).toBe(200);
    expect(res._getJSONData()).toEqual({ code: 'minted-code', expiresInSeconds: 60 });
    expect(res.getHeader('Cache-Control')).toBe('no-store');
    expect(h.mintDesktopWebSessionCode).toHaveBeenCalledWith({ userId: USER.id, parentSid: USER.sid });
    expect(h.findBySid).toHaveBeenCalledWith(USER.sid);
  });

  it.each([
    ['a web browser', { clientId: null, createdVia: 'login' }],
    ['the CLI', { clientId: 'b4m-cli', createdVia: 'device' }],
    ['a missing', null],
  ])('refuses %s session, since only the Desktop client may trade itself in', async (_label, session) => {
    h.findBySid.mockResolvedValue(session);
    const res = await run(USER);

    expect(res.statusCode).toBe(403);
    expect(h.mintDesktopWebSessionCode).not.toHaveBeenCalled();
  });

  it('refuses a session that is impersonated, pre-MFA, deletion-pending or owes enrollment', async () => {
    h.admitsOptionalAuthSession.mockResolvedValue(false);
    const res = await run({ ...USER, impersonatedBy: 'admin' });

    expect(res.statusCode).toBe(403);
    expect(h.mintDesktopWebSessionCode).not.toHaveBeenCalled();
  });

  it('refuses a token without a session id, whose revocation could not be checked at redemption', async () => {
    const res = await run({ id: USER.id });

    expect(res.statusCode).toBe(403);
    expect(h.mintDesktopWebSessionCode).not.toHaveBeenCalled();
  });
});
