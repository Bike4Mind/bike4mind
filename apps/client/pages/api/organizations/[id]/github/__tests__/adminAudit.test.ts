// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  registered: {} as Record<string, Handler>,
  verifyOrgOwner: vi.fn(),
  recordAdminActionFromRequest: vi.fn(async () => null),
  connectionRepo: {
    findByOrganizationId: vi.fn(),
    findByOrganizationIdAny: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgOwner: h.verifyOrgOwner }));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: h.recordAdminActionFromRequest,
}));
vi.mock('@bike4mind/database', () => ({ orgGitHubConnectionRepository: h.connectionRepo }));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: (value: string) => `enc(${value})`,
  decryptSecret: vi.fn(),
  isEncrypted: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/integrations/github/githubConnectionAuditLog', () => ({
  logConnectionCreated: vi.fn(),
  logConnectionUpdated: vi.fn(),
  logConnectionDeleted: vi.fn(),
  logKeyRotated: vi.fn(),
  logPatRotated: vi.fn(),
}));

const load = async (loader: () => Promise<unknown>) => {
  for (const key of Object.keys(h.registered)) delete h.registered[key];
  await loader();
  return { ...h.registered };
};

const makeRes = () => {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res) };
  return res;
};

const ORG = { id: 'org-1', name: 'Acme' };

describe('GitHub connection routes write team audit entries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.verifyOrgOwner.mockResolvedValue(ORG);
  });

  it('records a PAT rotation without the token', async () => {
    h.connectionRepo.findByOrganizationId.mockResolvedValue({ id: 'conn-1', connectionType: 'service_account' });
    const { post } = await load(() => import('../rotate-pat'));

    await post({ query: { id: 'org-1' }, user: { id: 'owner-1' }, body: { accessToken: 'ghp_plaintoken' } }, makeRes());

    expect(h.recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    const [, entry] = h.recordAdminActionFromRequest.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(entry).toMatchObject({
      action: 'org.github_connection.pat_rotated',
      actorScope: 'organization',
      target: { kind: 'organization', id: 'org-1', displayName: 'Acme' },
      details: { connectionId: 'conn-1' },
    });
    expect(JSON.stringify(entry)).not.toContain('ghp_plaintoken');
  });

  it('records a disconnect', async () => {
    h.connectionRepo.findByOrganizationIdAny.mockResolvedValue({ id: 'conn-1', connectionType: 'github_app' });
    const routes = await load(() => import('../connection'));

    await routes.delete({ query: { id: 'org-1' }, user: { id: 'owner-1' } }, makeRes());

    expect(h.recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.github_connection.deleted',
        details: { connectionId: 'conn-1', connectionType: 'github_app' },
      })
    );
  });
});
