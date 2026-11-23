import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

/**
 * GET /api/oauth/userinfo claim projection. A relying-party OAuth token releases only the claims
 * its granted scopes cover (OIDC Core 5.4). A first-party / legacy access token carries no
 * oauthGrant marker and is NOT scope-limited, so it must keep the full claim set - the behavior
 * before scoped OAuth (the "first-party unchanged" contract).
 */

const mockRefs = vi.hoisted(() => ({ options: null as unknown, recordRefusal: vi.fn() }));

vi.mock('@bike4mind/server-utils/auth/sideAppRefusal', () => ({ recordSideAppRefusal: mockRefs.recordRefusal }));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    mockRefs.options = options;
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

const run = (user: unknown, apiKeyInfo?: unknown) => {
  const { req, res } = createMocks({ method: 'GET' });
  if (user) (req as Record<string, unknown>).user = user;
  if (apiKeyInfo) (req as Record<string, unknown>).apiKeyInfo = apiKeyInfo;
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
  it('declares me:read or admin and grandfathers legacy keys', () => {
    expect(mockRefs.options).toMatchObject({
      requiredScopes: [ApiKeyScope.ME_READ, ApiKeyScope.ADMIN],
      grandfatherLegacyKeys: true,
    });
  });

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

  it('403s a key minted for a connected app and releases no claims', async () => {
    const { res, promise } = run(fullUser, { scopes: ['me:read'], oauthExchangeClientId: 'client-1' });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(res._getData()).not.toContain('a@b.co');
    expect(mockRefs.recordRefusal).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'client-1', status: 403 }));
  });

  it('still returns claims for an ordinary API key', async () => {
    const { res, promise } = run(fullUser, { scopes: ['me:read'] });
    await promise;
    expect(res._getJSONData()).toMatchObject({ sub: 'u1', email: 'a@b.co' });
  });
});
