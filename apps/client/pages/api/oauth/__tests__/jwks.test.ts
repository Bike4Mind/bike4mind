import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: NextApiRequest, res: NextApiResponse) => Promise<unknown>),
  getJwks: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain = {
    get: (fn: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>) => {
      h.handler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@server/auth/oauthServer', () => ({ getJwks: h.getJwks }));

import '@pages/api/oauth/jwks';

const JWKS = { keys: [{ kty: 'RSA', n: 'n', e: 'AQAB', use: 'sig', alg: 'RS256', kid: 'kid-1' }] };

async function get() {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>({ method: 'GET' });
  await h.handler!(req, res);
  return { body: res._getJSONData(), cacheControl: res.getHeader('Cache-Control') };
}

describe('GET /api/oauth/jwks', () => {
  beforeEach(() => h.getJwks.mockReset());

  it('publishes the key set as cacheable when it holds the stage-wide key', async () => {
    h.getJwks.mockResolvedValue({ jwks: JWKS, cacheable: true });

    const { body, cacheControl } = await get();

    expect(body).toEqual(JWKS);
    expect(cacheControl).toBe('public, max-age=3600');
  });

  it('forbids caching an instance-local stopgap key', async () => {
    h.getJwks.mockResolvedValue({ jwks: JWKS, cacheable: false });

    const { body, cacheControl } = await get();

    expect(body).toEqual(JWKS);
    expect(cacheControl).toBe('no-store');
  });
});
