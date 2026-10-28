import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindById, mockFindByEmailDomain, mockUpdateIDP } = vi.hoisted(() => ({
  mockFindById: vi.fn(),
  mockFindByEmailDomain: vi.fn(),
  mockUpdateIDP: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain: Record<string, unknown> = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return h[(req as { method?: string }).method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((h.GET = fn), chain),
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        delete: (fn: (req: unknown, res: unknown) => unknown) => ((h.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: () => unknown) => fn(),
  identityProviderRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findByEmailDomain: (...a: unknown[]) => mockFindByEmailDomain(...a),
    updateIDP: (...a: unknown[]) => mockUpdateIDP(...a),
  },
}));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn() } }));
vi.mock('@server/auth/oktaOidcClient', () => ({ clearConfigurationCache: vi.fn() }));

vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));

import handler from '../[id]';

const call = async (method: string, body?: unknown) => {
  const { req, res } = createMocks({ method: method as 'GET', query: { id: 'idp1' }, body: body as object });
  (req as unknown as Record<string, unknown>).user = { id: 'a1', isAdmin: true };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const leakyProvider = {
  id: 'idp1',
  name: 'Acme Okta',
  emailDomain: 'acme.test',
  type: 'okta',
  isActive: true,
  createdBy: 'a1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  samlConfig: { entryPoint: 'e', issuer: 'i', cert: 'c', decryptionPvk: 'PRIVATE-KEY', privateCert: 'PRIVATE-CERT' },
  oktaConfig: { audience: 'api://x', clientId: 'cid', clientSecret: 'OKTA-SECRET' },
  somethingUndeclared: 'x',
};

const expectNoCredentials = (body: Record<string, unknown>) => {
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE-KEY|PRIVATE-CERT|OKTA-SECRET/);
  expect(body).not.toHaveProperty('somethingUndeclared');
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/admin/identity-providers/[id] response schema', () => {
  it('GET never returns credential values or undeclared fields', async () => {
    mockFindById.mockResolvedValue(leakyProvider);
    const res = await call('GET');
    expect(res._getStatusCode()).toBe(200);
    expectNoCredentials(res._getJSONData());
    expect(res._getJSONData().oktaConfig.clientId).toBe('cid');
  });

  it('PUT never returns credential values or undeclared fields', async () => {
    mockFindByEmailDomain.mockResolvedValue(null);
    mockUpdateIDP.mockResolvedValue(leakyProvider);
    const res = await call('PUT', { name: 'Acme Okta' });
    expect(res._getStatusCode()).toBe(200);
    expectNoCredentials(res._getJSONData());
  });
});
