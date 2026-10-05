// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findByOrganizationId: vi.fn(),
  update: vi.fn(),
  countByOrganization: vi.fn(),
  incrementCounterConditional: vi.fn(),
  verifyOrgAccess: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    post: (fn: (req: unknown, res: unknown) => Promise<unknown>) => {
      h.handler = fn;
      return {};
    },
  }),
}));

vi.mock('@bike4mind/database/infra', () => ({
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId, update: h.update },
  webhookSubscriptionRepository: { countByOrganization: h.countByOrganization },
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { incrementCounterConditional: h.incrementCounterConditional },
}));
vi.mock('@server/integrations/github/webhookUtils', () => ({
  generateWebhookSecret: () => 'new-plain-secret',
}));
vi.mock('@server/security/secretEncryption', () => ({
  encryptSecret: (value: string) => `enc(${value})`,
}));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));

await import('../rotate-secret');

const storedConfig = {
  id: 'cfg-1',
  organizationId: 'org-1',
  routingToken: 'rt-1',
  secret: 'enc(old-secret)',
  repos: ['acme/repo'],
  subscribedEvents: ['push'],
  createdBy: 'user-1',
  enabled: true,
};

const makeRes = () => {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

describe('POST /api/organizations/[id]/webhooks/github/rotate-secret', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.incrementCounterConditional.mockResolvedValue({ success: true });
    h.findByOrganizationId.mockResolvedValue({ ...storedConfig });
    h.update.mockImplementation(async (partial: Record<string, unknown>) => ({ ...storedConfig, ...partial }));
    h.countByOrganization.mockResolvedValue(0);
  });

  it('writes exactly the new encrypted secret and reveals the plain one once', async () => {
    const res = makeRes();

    await h.handler!({ query: { id: 'org-1' }, user: { id: 'user-1' } }, res);

    expect(h.verifyOrgAccess).toHaveBeenCalledWith({ id: 'user-1' }, 'org-1');
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.update).toHaveBeenCalledWith({ id: 'cfg-1', secret: 'enc(new-plain-secret)' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ secret: 'new-plain-secret' }));
  });

  it('writes nothing when the rate limit is exhausted', async () => {
    h.incrementCounterConditional.mockResolvedValue({ success: false });

    await expect(h.handler!({ query: { id: 'org-1' }, user: { id: 'user-1' } }, makeRes())).rejects.toThrow(
      /Rate limit exceeded/
    );
    expect(h.update).not.toHaveBeenCalled();
  });
});
