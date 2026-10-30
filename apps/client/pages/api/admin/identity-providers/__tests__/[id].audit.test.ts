// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  findById: vi.fn(),
  findByEmailDomain: vi.fn(),
  updateIDP: vi.fn(),
  deleteIDP: vi.fn(),
  clearConfigurationCache: vi.fn(),
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
        put: (fn: Route) => ((routes.PUT = fn), chain),
        delete: (fn: Route) => ((routes.DELETE = fn), chain),
      }
    );
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  identityProviderRepository: {
    findById: h.findById,
    findByEmailDomain: h.findByEmailDomain,
    updateIDP: h.updateIDP,
    deleteIDP: h.deleteIDP,
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@server/auth/oktaOidcClient', () => ({ clearConfigurationCache: h.clearConfigurationCache }));
vi.mock('@bike4mind/observability', () => ({ Logger: { info: vi.fn() } }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: h.audit }));

import handler from '../[id]';

const CLIENT_SECRET = 'okta-client-secret-value';
const existing = { id: 'idp-1', name: 'Acme SSO', emailDomain: 'acme.com', type: 'okta', isActive: true };

const call = async (method: 'PUT' | 'DELETE', body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, query: { id: 'idp-1' }, body });
  (req as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return { req, res };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  h.findById.mockResolvedValue(existing);
  h.findByEmailDomain.mockResolvedValue(null);
  h.updateIDP.mockResolvedValue({ ...existing, name: 'Acme Okta', isActive: false });
  h.deleteIDP.mockResolvedValue(true);
  h.audit.mockResolvedValue(null);
});

describe('PUT /api/admin/identity-providers/[id] admin audit', () => {
  const body = { name: 'Acme Okta', isActive: false, oktaConfig: { clientSecret: CLIENT_SECRET } };

  it('records a strict updated entry with a non-secret diff', async () => {
    const { req, res } = await call('PUT', body);

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][0]).toBe(req);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'identity.sso_provider.updated',
      target: { kind: 'settings', id: 'idp-1', displayName: 'Acme Okta' },
      details: { certReplaced: false, oktaClientSecretReplaced: true, samlKeyMaterialReplaced: false },
    });
    expect(h.audit.mock.calls[0][1].changes).toEqual([
      { field: 'name', before: 'Acme SSO', after: 'Acme Okta' },
      { field: 'isActive', before: true, after: false },
    ]);
    expect(JSON.stringify(h.audit.mock.calls[0][1])).not.toContain(CLIENT_SECRET);
    expect(h.updateIDP.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('diffs non-secret SAML and Okta config and never records credential values', async () => {
    const before = {
      ...existing,
      samlConfig: { entryPoint: 'https://old/sso', issuer: 'iss', cert: 'CERT-OLD', identifierFormat: 'f' },
      oktaConfig: { audience: 'api://a', clientId: 'cid', authServerId: 'default', useOrgAuthServer: false },
    };
    h.findById.mockResolvedValue(before);
    h.updateIDP.mockResolvedValue({
      ...before,
      samlConfig: { ...before.samlConfig, entryPoint: 'https://new/sso', cert: 'CERT-NEW' },
      oktaConfig: { ...before.oktaConfig, useOrgAuthServer: true },
    });

    await call('PUT', { samlConfig: { decryptionPvk: 'SAML-PVK' }, oktaConfig: { clientSecret: CLIENT_SECRET } });

    const entry = h.audit.mock.calls[0][1];
    expect(entry.changes).toEqual([
      { field: 'samlConfig.entryPoint', before: 'https://old/sso', after: 'https://new/sso' },
      { field: 'oktaConfig.useOrgAuthServer', before: false, after: true },
    ]);
    expect(entry.details).toEqual({
      certReplaced: true,
      oktaClientSecretReplaced: true,
      samlKeyMaterialReplaced: true,
    });
    expect(JSON.stringify(entry)).not.toMatch(/CERT-OLD|CERT-NEW|SAML-PVK|okta-client-secret-value/);
  });

  it('reports no secret replacement when none is submitted', async () => {
    await call('PUT', { name: 'Acme Okta', oktaConfig: { clientId: 'cid', clientSecret: '' } });

    expect(h.audit.mock.calls[0][1].details).toEqual({
      certReplaced: false,
      oktaClientSecretReplaced: false,
      samlKeyMaterialReplaced: false,
    });
  });

  it('returns 404 without writing when the provider does not exist', async () => {
    h.findById.mockResolvedValue(null);

    const { res } = await call('PUT', body);

    expect(res._getStatusCode()).toBe(404);
    expect(h.updateIDP).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 500 and leaves the OIDC cache alone when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await call('PUT', body);

    expect(res._getStatusCode()).toBe(500);
    expect(h.clearConfigurationCache).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/identity-providers/[id] admin audit', () => {
  it('records a strict deleted entry', async () => {
    const { res } = await call('DELETE');

    expect(res._getStatusCode()).toBe(200);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit.mock.calls[0][1]).toMatchObject({
      action: 'identity.sso_provider.deleted',
      target: { kind: 'settings', id: 'idp-1', displayName: 'Acme SSO' },
      details: { emailDomain: 'acme.com', type: 'okta' },
    });
    expect(h.deleteIDP.mock.invocationCallOrder[0]).toBeLessThan(h.audit.mock.invocationCallOrder[0]);
  });

  it('returns 404 without deleting when the provider does not exist', async () => {
    h.findById.mockResolvedValue(null);

    const { res } = await call('DELETE');

    expect(res._getStatusCode()).toBe(404);
    expect(h.deleteIDP).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('returns 500 and leaves the OIDC cache alone when the audit write rejects', async () => {
    h.audit.mockRejectedValue(new Error('audit down'));

    const { res } = await call('DELETE');

    expect(res._getStatusCode()).toBe(500);
    expect(res._getJSONData()).not.toHaveProperty('success');
    expect(h.clearConfigurationCache).not.toHaveBeenCalled();
  });
});
