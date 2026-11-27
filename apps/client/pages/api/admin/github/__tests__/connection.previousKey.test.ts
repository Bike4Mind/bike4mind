// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

type Route = (req: unknown, res: unknown) => unknown;

const h = vi.hoisted(() => ({
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  findSystemDefault: vi.fn(),
  findSystemDefaultWithCredentials: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, Route> = {};
    const chain = Object.assign((req: unknown, res: unknown) => routes[(req as { method: string }).method](req, res), {
      use: () => chain,
      get: (fn: Route) => ((routes.GET = fn), chain),
      post: (fn: Route) => ((routes.POST = fn), chain),
      put: (fn: Route) => ((routes.PUT = fn), chain),
      delete: (fn: Route) => ((routes.DELETE = fn), chain),
    });
    return chain;
  },
}));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  orgGitHubConnectionRepository: {
    findSystemDefault: h.findSystemDefault,
    findSystemDefaultWithCredentials: h.findSystemDefaultWithCredentials,
    update: h.update,
  },
  withTransaction: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@bike4mind/observability', () => ({
  Logger: Object.assign(
    class {
      info = vi.fn();
      error = vi.fn();
    },
    { error: vi.fn() }
  ),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn(async () => null) }));

import handler from '../connection';

const maskOf = (value: string) => '*'.repeat(value.length - 4) + value.slice(-4);

const baseConnection = {
  id: 'conn-1',
  organizationId: null,
  connectedBy: 'admin-1',
  connectedAt: new Date('2026-01-01T00:00:00Z'),
  allowedRepositories: ['acme/one'],
  enabled: true,
  isSystemDefault: true,
};

const call = async (method: 'GET' | 'PUT', body?: Record<string, unknown>) => {
  const { req, res } = createMocks({ method, body });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', isAdmin: true };
  await (handler as unknown as Route)(req, res);
  return res;
};

describe.each([
  {
    label: 'a GitHub App private key',
    plaintext: 'github-app-key-fixture',
    connection: { ...baseConnection, connectionType: 'github_app', appId: '123', installationId: '456' },
    credentialField: 'privateKey',
    maskedField: 'privateKeyMasked',
  },
  {
    label: 'a service account access token',
    plaintext: 'service-account-credential-fixture',
    connection: { ...baseConnection, connectionType: 'service_account' },
    credentialField: 'accessToken',
    maskedField: 'accessTokenMasked',
  },
])('/api/admin/github/connection with $label stored under the previous encryption key', spec => {
  beforeEach(() => {
    vi.clearAllMocks();
    const previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    const credentials = { ...spec.connection, [spec.credentialField]: encryptSecret(spec.plaintext, previousKey) };
    h.findSystemDefault.mockResolvedValue({ ...spec.connection, [spec.credentialField]: 'redacted' });
    h.findSystemDefaultWithCredentials.mockResolvedValue(credentials);
    h.update.mockResolvedValue({ ...spec.connection });
  });

  it('GET returns the masked credential', async () => {
    const res = await call('GET');

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().connection[spec.maskedField]).toBe(maskOf(spec.plaintext));
  });

  it('PUT returns the masked credential', async () => {
    const res = await call('PUT', { enabled: true });

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().connection[spec.maskedField]).toBe(maskOf(spec.plaintext));
  });
});
