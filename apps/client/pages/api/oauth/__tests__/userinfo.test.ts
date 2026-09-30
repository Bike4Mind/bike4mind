import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/oauth/userinfo claim projection. A relying-party OAuth token releases only the claims
 * its granted scopes cover (OIDC Core 5.4). A first-party / legacy access token carries no
 * oauthGrant marker and is NOT scope-limited, so it must keep the full claim set - the behavior
 * before scoped OAuth (the "first-party unchanged" contract).
 */

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

import handler from '../userinfo';

const run = (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const fullUser = {
  id: 'u1',
  email: 'a@b.co',
  emailVerified: true,
  username: 'ada',
  oauthCredentials: { picture: 'p.png' },
};

describe('GET /api/oauth/userinfo', () => {
  it('401s when there is no authenticated user', async () => {
    const { res, promise } = run(undefined);
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('returns the FULL claim set for a first-party / legacy token (no oauthGrant)', async () => {
    const { res, promise } = run(fullUser);
    await promise;
    const body = res._getJSONData();
    expect(body).toEqual({
      sub: 'u1',
      email: 'a@b.co',
      email_verified: true,
      name: 'ada',
      picture: 'p.png',
    });
  });

  it('returns sub alone for an openid-only OAuth token', async () => {
    const { res, promise } = run({ ...fullUser, oauthGrant: { scopes: ['openid'], clientId: 'c1' } });
    await promise;
    expect(res._getJSONData()).toEqual({ sub: 'u1' });
  });

  it('releases email claims only when the OAuth token holds the email scope', async () => {
    const { res, promise } = run({ ...fullUser, oauthGrant: { scopes: ['openid', 'email'], clientId: 'c1' } });
    await promise;
    const body = res._getJSONData();
    expect(body).toMatchObject({ sub: 'u1', email: 'a@b.co', email_verified: true });
    expect(body.name).toBeUndefined();
    expect(body.picture).toBeUndefined();
  });

  it('releases profile claims only when the OAuth token holds the profile scope', async () => {
    const { res, promise } = run({ ...fullUser, oauthGrant: { scopes: ['openid', 'profile'], clientId: 'c1' } });
    await promise;
    const body = res._getJSONData();
    expect(body).toMatchObject({ sub: 'u1', name: 'ada', picture: 'p.png' });
    expect(body.email).toBeUndefined();
  });
});
