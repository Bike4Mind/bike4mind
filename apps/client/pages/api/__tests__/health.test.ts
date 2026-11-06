import { afterEach, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const route = vi.hoisted(() => ({
  get: undefined as undefined | ((req: NextApiRequest, res: NextApiResponse) => unknown),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const chain = {
      use: () => chain,
      get: (fn: typeof route.get) => {
        route.get = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { STAGE: 'pr123' } }));
import '../health';

afterEach(() => vi.unstubAllEnvs());
function probe() {
  const headers: Record<string, unknown> = {};
  let body: Record<string, unknown> = {};
  const res = {
    setHeader: (k: string, v: unknown) => {
      headers[k] = v;
    },
    status: () => res,
    json: (v: typeof body) => {
      body = v;
    },
  };
  route.get!({} as NextApiRequest, res as unknown as NextApiResponse);
  return { body, headers };
}
it('returns only optional public revision fields and disables caching', () => {
  vi.stubEnv('B4M_DEPLOYED_REVISION', 'a'.repeat(40));
  vi.stubEnv('B4M_BUILD_FINGERPRINT', 'b'.repeat(64));
  vi.stubEnv('PRIVATE_CONFIGURATION', 'private');
  const { body, headers } = probe();
  expect(headers['Cache-Control']).toBe('no-store');
  expect(body).toMatchObject({
    status: 'ok',
    stage: 'pr123',
    deployedRevision: 'a'.repeat(40),
    buildFingerprint: 'b'.repeat(64),
  });
  expect(Object.keys(body).sort()).toEqual([
    'buildFingerprint',
    'deployedRevision',
    'stage',
    'status',
    'timestamp',
    'uptimeSeconds',
  ]);
});
it('omits missing or malformed revision fields', () => {
  vi.stubEnv('B4M_DEPLOYED_REVISION', 'main');
  vi.stubEnv('B4M_BUILD_FINGERPRINT', '');
  expect(probe().body).not.toHaveProperty('deployedRevision');
  expect(probe().body).not.toHaveProperty('buildFingerprint');
});
