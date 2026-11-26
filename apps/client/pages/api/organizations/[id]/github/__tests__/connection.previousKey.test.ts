// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encryptSecret, generateEncryptionKey, configureSecretsAtRest } from '@bike4mind/utils/security';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  registered: {} as Record<string, Handler>,
  config: {} as { SECRET_ENCRYPTION_KEY?: string; SECRET_ENCRYPTION_KEY_PREVIOUS?: string },
  connectionRepo: {
    findByOrganizationIdAny: vi.fn(),
    findByOrganizationIdAnyWithCredentials: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['get', 'post', 'put', 'delete']) {
    chain[method] = (fn: Handler) => {
      h.registered[method] = fn;
      return chain;
    };
  }
  chain.use = () => chain;
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => ({}) }));
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({
  verifyOrgPermission: vi.fn(async () => ({ id: 'org-1', name: 'Acme' })),
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn(async () => null) }));
vi.mock('@bike4mind/database', () => ({ orgGitHubConnectionRepository: h.connectionRepo }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: h.config }));
vi.mock('@server/integrations/github/githubConnectionAuditLog', () => ({
  logConnectionCreated: vi.fn(),
  logConnectionUpdated: vi.fn(),
  logConnectionDeleted: vi.fn(),
  logKeyRotated: vi.fn(),
  logPatRotated: vi.fn(),
}));

await import('../connection');

const maskOf = (value: string) => '*'.repeat(value.length - 4) + value.slice(-4);

const baseConnection = {
  id: 'conn-1',
  organizationId: 'org-1',
  connectedBy: 'owner-1',
  connectedAt: new Date('2026-01-01T00:00:00Z'),
  allowedRepositories: ['acme/one'],
  enabled: true,
  isSystemDefault: false,
};

const makeRes = () => {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
};

const call = async (method: 'get' | 'put', body?: Record<string, unknown>) => {
  const res = makeRes();
  await h.registered[method]({ query: { id: 'org-1' }, user: { id: 'owner-1' }, body }, res);
  return res.json.mock.calls[0][0] as { connection: Record<string, string> };
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
])('/api/organizations/[id]/github/connection with $label stored under the previous encryption key', spec => {
  beforeEach(() => {
    vi.clearAllMocks();
    const previousKey = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY = generateEncryptionKey();
    h.config.SECRET_ENCRYPTION_KEY_PREVIOUS = previousKey;
    configureSecretsAtRest(h.config.SECRET_ENCRYPTION_KEY, h.config.SECRET_ENCRYPTION_KEY_PREVIOUS);
    h.connectionRepo.findByOrganizationIdAny.mockResolvedValue({ ...spec.connection });
    h.connectionRepo.findByOrganizationIdAnyWithCredentials.mockResolvedValue({
      ...spec.connection,
      [spec.credentialField]: encryptSecret(spec.plaintext, previousKey),
    });
    h.connectionRepo.findOneAndUpdate.mockResolvedValue({ ...spec.connection });
  });

  it('GET returns the masked credential', async () => {
    const { connection } = await call('get');

    expect(connection[spec.maskedField]).toBe(maskOf(spec.plaintext));
  });

  it('PUT returns the masked credential', async () => {
    const { connection } = await call('put', { enabled: true });

    expect(connection[spec.maskedField]).toBe(maskOf(spec.plaintext));
  });
});
