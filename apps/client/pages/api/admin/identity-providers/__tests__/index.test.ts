import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindAllWithSecretPresence, mockFindByEmailDomain, mockCreateIDP } = vi.hoisted(() => ({
  mockFindAllWithSecretPresence: vi.fn(),
  mockFindByEmailDomain: vi.fn(),
  mockCreateIDP: vi.fn(),
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
        post: (fn: (req: unknown, res: unknown) => unknown) => ((h.POST = fn), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@bike4mind/database', () => ({
  withTransaction: (fn: () => unknown) => fn(),
  identityProviderRepository: {
    findAllWithSecretPresence: (...a: unknown[]) => mockFindAllWithSecretPresence(...a),
    findByEmailDomain: (...a: unknown[]) => mockFindByEmailDomain(...a),
    createIDP: (...a: unknown[]) => mockCreateIDP(...a),
  },
}));

vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn() }));

import handler from '../index';

const call = async (method: string, body?: unknown, user: object = { id: 'a1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: method as 'GET', body: body as object });
  (req as unknown as Record<string, unknown>).user = user;
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return res;
};

const SECRETS = ['decryptionPvk', 'privateCert', 'clientSecret'];

// Secrets and an undeclared field present on the stored shape, as if a read path regressed.
const leakyProvider = {
  id: 'idp1',
  name: 'Acme SSO',
  emailDomain: 'acme.test',
  type: 'saml',
  isActive: true,
  createdBy: 'a1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  samlConfig: {
    entryPoint: 'https://idp.acme.test/sso',
    issuer: 'acme',
    cert: 'PUBLIC-CERT',
    decryptionPvk: 'PRIVATE-KEY',
    privateCert: 'PRIVATE-CERT',
  },
  oktaConfig: { audience: 'api://x', clientId: 'cid', clientSecret: 'OKTA-SECRET' },
  __v: 0,
  somethingUndeclared: 'x',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/admin/identity-providers response schema', () => {
  it('GET never returns credential values and keeps the presence flags', async () => {
    mockFindAllWithSecretPresence.mockResolvedValue([
      { ...leakyProvider, hasSecrets: { decryptionPvk: true, privateCert: true, clientSecret: true } },
    ]);
    const res = await call('GET');
    expect(res._getStatusCode()).toBe(200);

    const [row] = res._getJSONData();
    for (const field of SECRETS) {
      expect(row.samlConfig).not.toHaveProperty(field);
      expect(row.oktaConfig).not.toHaveProperty(field);
    }
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE-KEY|PRIVATE-CERT|OKTA-SECRET/);
    expect(row).not.toHaveProperty('somethingUndeclared');
    expect(row.hasSecrets).toEqual({ decryptionPvk: true, privateCert: true, clientSecret: true });
    expect(row.samlConfig.cert).toBe('PUBLIC-CERT');
  });

  it('POST responds 201 without credential values or undeclared fields', async () => {
    mockFindByEmailDomain.mockResolvedValue(null);
    mockCreateIDP.mockResolvedValue(leakyProvider);
    const res = await call('POST', {
      name: 'Acme SSO',
      emailDomain: 'acme.test',
      type: 'saml',
      samlConfig: { entryPoint: 'https://idp.acme.test/sso', issuer: 'acme', cert: 'PUBLIC-CERT' },
    });
    expect(res._getStatusCode()).toBe(201);

    const body = res._getJSONData();
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE-KEY|PRIVATE-CERT|OKTA-SECRET/);
    expect(body).not.toHaveProperty('somethingUndeclared');
    expect(body.id).toBe('idp1');
  });

  it('refuses a non-admin before reading or creating anything', async () => {
    const nonAdmin = { id: 'u1', isAdmin: false };
    await expect(call('GET', undefined, nonAdmin)).rejects.toThrow(/missing permission/i);
    await expect(call('POST', { name: 'x' }, nonAdmin)).rejects.toThrow(/missing permission/i);
    expect(mockFindAllWithSecretPresence).not.toHaveBeenCalled();
    expect(mockCreateIDP).not.toHaveBeenCalled();
  });
});
