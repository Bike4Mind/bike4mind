// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findByEmailDomain: vi.fn(),
  createIDP: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const middlewares: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const routes: Record<string, Route> = {};
    const chain = Object.assign(
      async (req: unknown, res: unknown) => {
        for (const middleware of middlewares) middleware(req, res, () => undefined);
        return routes[(req as { method: string }).method](req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (middlewares.push(fn), chain),
        get: (fn: Route) => ((routes.GET = fn), chain),
        post: (fn: Route) => ((routes.POST = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  identityProviderRepository: { findByEmailDomain: h.findByEmailDomain, createIDP: h.createIDP },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../index';

const CLIENT_SECRET = 'okta-client-secret-value';

const create = async () => {
  const { req, res } = createMocks({
    method: 'POST',
    body: {
      name: 'Acme SSO',
      emailDomain: 'Acme.com',
      type: 'okta',
      oktaConfig: { issuer: 'https://acme.okta.com', clientId: 'cid', clientSecret: CLIENT_SECRET },
    },
  });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.findByEmailDomain.mockResolvedValue(null);
  h.createIDP.mockResolvedValue({
    id: 'idp-1',
    name: 'Acme SSO',
    emailDomain: 'acme.com',
    type: 'okta',
    isActive: true,
    oktaConfig: { issuer: 'https://acme.okta.com', clientId: 'cid', clientSecret: CLIENT_SECRET },
  });
  h.audit.mockResolvedValue(null);
});

describe('POST /api/admin/identity-providers admin audit', () => {
  it('records a strict created entry with no provider config', async () => {
    const { req, res } = await create();

    expect(res._getStatusCode()).toBe(201);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'identity.sso_provider.created',
      target: { kind: 'settings', id: 'idp-1', displayName: 'Acme SSO' },
      details: { name: 'Acme SSO', emailDomain: 'acme.com', type: 'okta', isActive: true },
    });
    const serialized = JSON.stringify(h.audit.mock.calls[0][1]);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain('oktaConfig');
    expect(h.createIDP.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('returns 500 when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await create();

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).not.toHaveProperty('id');
  });
});
