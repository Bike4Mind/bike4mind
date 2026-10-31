// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';

type Handler = (req: unknown, res: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  registered: {} as Record<string, Handler>,
  verifyOrgOwner: vi.fn(),
  forOrganization: vi.fn(),
  connectionRepo: {
    findByOrganizationId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
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
vi.mock('@bike4mind/server-utils/services/githubService', () => ({
  GitHubService: { forOrganization: h.forOrganization },
}));
vi.mock('@bike4mind/database', () => ({ orgGitHubConnectionRepository: h.connectionRepo }));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: h.encryptSecret,
  decryptSecret: h.decryptSecret,
  isEncrypted: () => false,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));
vi.mock('@server/integrations/github/githubConnectionAuditLog', () => ({
  logConnectionCreated: vi.fn(),
  logConnectionUpdated: vi.fn(),
  logConnectionDeleted: vi.fn(),
  logKeyRotated: vi.fn(),
  logPatRotated: vi.fn(),
  logTestExecuted: vi.fn(),
}));

// Each case loads one route and reads back the handlers it registered at import.
const load = async (loader: () => Promise<unknown>) => {
  for (const key of Object.keys(h.registered)) delete h.registered[key];
  await loader();
  return { ...h.registered };
};

const routes: Array<[string, string, () => Promise<unknown>]> = [
  ['connection', 'post', () => import('../connection')],
  ['connection', 'get', () => import('../connection')],
  ['connection', 'put', () => import('../connection')],
  ['connection', 'delete', () => import('../connection')],
  ['rate-limit', 'get', () => import('../rate-limit')],
  ['repositories', 'get', () => import('../repositories')],
  ['rotate-key', 'post', () => import('../rotate-key')],
  ['rotate-pat', 'post', () => import('../rotate-pat')],
  ['test', 'post', () => import('../test')],
];

// These routes read or rotate the org's GitHub App key / PAT, so a manager must be refused before
// any connection, secret or GitHub call is touched. Only `verifyOrgOwner` is mocked from orgAccess,
// so a route reverted to another gate would throw on a missing export instead of passing.
describe('GitHub integration routes are owner-only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.verifyOrgOwner.mockRejectedValue(new NotFoundError('Organization not found'));
  });

  it.each(routes)('%s %s refuses a non-owner and touches nothing', async (_name, method, loader) => {
    vi.resetModules();
    const handlers = await load(loader);
    const req = {
      query: { id: 'org-1' },
      user: { id: 'manager-1' },
      body: { privateKey: 'k', token: 't' },
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    };
    const res = { setHeader: vi.fn(), status: vi.fn(() => res), json: vi.fn(() => res) };

    await expect(handlers[method](req, res)).rejects.toThrow(NotFoundError);

    expect(h.verifyOrgOwner).toHaveBeenCalledWith(req.user, 'org-1');
    for (const spy of Object.values(h.connectionRepo)) expect(spy).not.toHaveBeenCalled();
    expect(h.forOrganization).not.toHaveBeenCalled();
    expect(h.decryptSecret).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});
