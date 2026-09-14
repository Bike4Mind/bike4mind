import { describe, it, expect, vi } from 'vitest';
import { oauthRouteGate } from './oauthRouteGate';

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
  oauthRouteGate(policy)({ user } as never, res as never, next);
  return { next, res };
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
