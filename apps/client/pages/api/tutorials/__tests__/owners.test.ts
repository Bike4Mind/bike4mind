import { describe, it, expect, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ForbiddenError } from '@bike4mind/common';

const OWNERS = vi.hoisted(() => [
  { owner: 'alpha', label: 'Alpha', adminBase: '/api/premium-alpha/tutorial', adminHref: '/alpha?mode=admin' },
]);

vi.mock('@bike4mind/server-utils/premium-generated/premiumTutorialOwners.generated', () => ({
  premiumTutorialOwners: OWNERS,
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (config?: unknown) => {
    let get: ((req: unknown, res: unknown) => unknown) | undefined;
    const chain = Object.assign(async (req: unknown, res: unknown) => get?.(req, res), {
      get: (fn: (req: unknown, res: unknown) => unknown) => ((get = fn), chain),
      _config: config,
    });
    return chain;
  },
}));

import handler from '../owners';

const call = (user: Record<string, unknown>) => {
  const { req, res } = createMocks({ method: 'GET' });
  (req as unknown as Record<string, unknown>).user = user;
  const promise = (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { res, promise };
};

describe('GET /api/tutorials/owners', () => {
  it('is declared jwtOnly, so an API key never reaches it', () => {
    const config = (handler as unknown as { _config: { auth?: string } })._config;
    expect(config.auth).toBe('jwtOnly');
  });

  it('returns the generated list to a full admin', async () => {
    const { res, promise } = call({ id: 'a1', isAdmin: true });
    await promise;
    expect(res._getJSONData()).toEqual({ owners: OWNERS });
  });

  it('refuses a delegated admin who holds settings:manage but is not isAdmin', async () => {
    const { res, promise } = call({ id: 'd1', isAdmin: false, adminPermissions: ['settings:manage'] });
    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
    expect(res._getData()).toBe('');
  });
});
