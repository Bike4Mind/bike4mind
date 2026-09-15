import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-level cover for the orgAccess guard on an org-scoped route. Mongo treats
 * ObjectId hex case-insensitively, so an uppercase-hex orgId names the same
 * organization and must not be turned away as malformed.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: () => chain,
    delete: () => chain,
  };
  return { baseApi: () => chain };
});

const organizationRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const orgWebhookConfigRepository = vi.hoisted(() => ({ findByOrganizationId: vi.fn() }));
const webhookSubscriptionRepository = vi.hoisted(() => ({ countByOrganization: vi.fn() }));
vi.mock('@bike4mind/database/infra', () => ({
  organizationRepository,
  orgWebhookConfigRepository,
  webhookSubscriptionRepository,
}));
vi.mock('@server/integrations/github/webhookUtils', () => ({
  generateWebhookToken: () => 'token',
  generateWebhookSecret: () => 'secret',
}));
vi.mock('@server/security/secretEncryption', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: undefined } }));

import '@pages/api/organizations/[id]/webhooks/github';

const ORG_ID = '507f1f77bcf86cd799439011';

const call = (orgId: string) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: orgId } });
  (req as any).user = { id: 'owner1', isAdmin: false };
  return { res, result: mockRefs.getHandler!(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  organizationRepository.findById.mockResolvedValue({ id: ORG_ID, userId: 'owner1', managerId: null });
  orgWebhookConfigRepository.findByOrganizationId.mockResolvedValue({
    id: 'cfg1',
    organizationId: ORG_ID,
    routingToken: 'token',
    repos: [],
    subscribedEvents: [],
    createdBy: 'owner1',
    enabled: true,
    secret: 'enc',
  });
  webhookSubscriptionRepository.countByOrganization.mockResolvedValue(0);
});

describe('GET /api/organizations/[id]/webhooks/github', () => {
  it('returns the webhook config for a lowercase-hex org id', async () => {
    const { res, result } = call(ORG_ID);
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().organizationId).toBe(ORG_ID);
  });

  it('accepts an uppercase-hex org id, which addresses the same organization', async () => {
    const { res, result } = call(ORG_ID.toUpperCase());
    await result;

    expect(res._getStatusCode()).toBe(200);
    expect(organizationRepository.findById).toHaveBeenCalledWith(ORG_ID.toUpperCase());
  });

  it('rejects an org id that is not object-id shaped', async () => {
    await expect(call('not-an-org-id').result).rejects.toThrow(/Invalid organization ID/);
    expect(organizationRepository.findById).not.toHaveBeenCalled();
  });
});
