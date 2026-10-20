import { describe, it, expect, vi } from 'vitest';
import { oauthRouteGate, admitsOptionalAuthUser } from './oauthRouteGate';

function mockRes() {
  const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

const run = (user: unknown, policy?: { oauthScopes?: string[] }) => {
  const next = vi.fn();
  const res = mockRes();
  const logger = { warn: vi.fn() };
  oauthRouteGate(policy)(
    { user, logger, originalUrl: '/api/agents/a1?x=1', query: { id: 'a1', x: '1' } } as never,
    res as never,
    next
  );
  return { next, res, logger };
};

describe('oauthRouteGate', () => {
  it('is a no-op for a first-party session (no oauthGrant), even on a first-party-only route', () => {
    const { next, res } = run({ id: 'u1' });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('default-denies an OAuth token on a first-party-only route (no oauthScopes)', () => {
    const { next, res } = run({ oauthGrant: { scopes: ['openid'] } });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows an OAuth token on an opted-in route with no required scope', () => {
    const { next, res } = run({ oauthGrant: { scopes: ['openid'] } }, { oauthScopes: [] });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an OAuth token missing a required scope', () => {
    const { next, res } = run({ oauthGrant: { scopes: ['openid'] } }, { oauthScopes: ['profile'] });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows an OAuth token that holds every required scope', () => {
    const { next, res } = run({ oauthGrant: { scopes: ['openid', 'profile'] } }, { oauthScopes: ['openid'] });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('oauthRouteGate error logging', () => {
  const LINE = '[OAUTH_ERROR] route=/api/agents/[id] client=c1 error=insufficient_scope status=403';

  it('logs the grant client on a first-party-only route', () => {
    const { logger } = run({ oauthGrant: { scopes: ['openid'], clientId: 'c1' } });
    expect(logger.warn.mock.calls).toEqual([[LINE]]);
  });

  it('logs the grant client when a required scope is missing', () => {
    const { logger } = run({ oauthGrant: { scopes: ['openid'], clientId: 'c1' } }, { oauthScopes: ['profile'] });
    expect(logger.warn.mock.calls).toEqual([[LINE]]);
  });

  it('logs nothing for a non-OAuth request or an allowed OAuth request', () => {
    expect(run({ id: 'u1' }).logger.warn).not.toHaveBeenCalled();
    expect(
      run({ oauthGrant: { scopes: ['openid'], clientId: 'c1' } }, { oauthScopes: ['openid'] }).logger.warn
    ).not.toHaveBeenCalled();
  });

  it('hides the route when an identical query value makes a path ID ambiguous', () => {
    const res = mockRes();
    const logger = { warn: vi.fn() };
    oauthRouteGate()(
      {
        user: { oauthGrant: { scopes: ['openid'], clientId: 'c1' } },
        logger,
        originalUrl: '/api/agents/a1?id=a1',
        query: { id: 'a1' },
      } as never,
      res as never,
      vi.fn()
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(logger.warn.mock.calls).toEqual([
      ['[OAUTH_ERROR] route=unknown client=c1 error=insufficient_scope status=403'],
    ]);
  });
});

describe('admitsOptionalAuthUser', () => {
  it('admits a plain first-party session', () => {
    expect(admitsOptionalAuthUser({ id: 'u1' })).toBe(true);
  });

  it('rejects a null/absent user (anonymous)', () => {
    expect(admitsOptionalAuthUser(null)).toBe(false);
    expect(admitsOptionalAuthUser(undefined)).toBe(false);
  });

  it('rejects a pre-MFA (mfaPending) session', () => {
    expect(admitsOptionalAuthUser({ id: 'u1', mfaPending: true })).toBe(false);
  });

  it('rejects a relying-party OAuth token (oauthGrant present)', () => {
    expect(admitsOptionalAuthUser({ id: 'u1', oauthGrant: { scopes: ['openid'], clientId: 'c1' } })).toBe(false);
  });
});
