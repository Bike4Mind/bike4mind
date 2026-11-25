import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * Route-level cover for the orgAccess guard on an org-scoped route. Mongo treats
 * ObjectId hex case-insensitively, so an uppercase-hex orgId names the same
 * organization and must not be turned away as malformed.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
  putHandler: null as null | ((req: unknown, res: unknown) => unknown),
  postHandler: null as null | ((req: unknown, res: unknown) => unknown),
  deleteHandler: null as null | ((req: unknown, res: unknown) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.postHandler = fn;
      return chain;
    },
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
    put: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.putHandler = fn;
      return chain;
    },
    delete: (fn: (req: unknown, res: unknown) => unknown) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const organizationRepository = vi.hoisted(() => ({ findById: vi.fn() }));
const orgWebhookConfigRepository = vi.hoisted(() => ({
  findByOrganizationId: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
}));
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
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({
  encryptSecret: (s: string) => s,
  decryptSecret: (s: string) => s,
}));
const configKey = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: {
    get SECRET_ENCRYPTION_KEY() {
      return configKey.value;
    },
  },
}));

const recordAdminActionFromRequest = vi.hoisted(() => vi.fn(async () => null));
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({ recordAdminActionFromRequest }));

import '@pages/api/organizations/[id]/webhooks/github';

const ORG_ID = '507f1f77bcf86cd799439011';

const call = (orgId: string, query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: orgId, ...query } });
  (req as any).user = { id: 'owner1', isAdmin: false };
  return { res, result: mockRefs.getHandler!(req, res) };
};

beforeEach(() => {
  vi.clearAllMocks();
  organizationRepository.findById.mockResolvedValue({ id: ORG_ID, userId: 'owner1' });
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

  it.each([{}, { revealSecret: 'true' }, { secret: 'true' }])(
    'never returns the plain secret (query %j)',
    async query => {
      const { res, result } = call(ORG_ID, query);
      await result;

      const body = res._getJSONData();
      expect(res._getStatusCode()).toBe(200);
      expect('secret' in body).toBe(false);
      expect(body.secretMasked).toBe('****');
      expect(JSON.stringify(body)).not.toContain('"enc"');
    }
  );

  it('rejects an org id that is not object-id shaped', async () => {
    await expect(call('not-an-org-id').result).rejects.toThrow(/Invalid organization ID/);
    expect(organizationRepository.findById).not.toHaveBeenCalled();
  });
});

describe('POST /api/organizations/[id]/webhooks/github', () => {
  it('returns the plain secret once, alongside the mask', async () => {
    configKey.value = 'fake-encryption-key';
    orgWebhookConfigRepository.findByOrganizationId.mockResolvedValue(null);
    orgWebhookConfigRepository.create.mockImplementation(async (doc: Record<string, unknown>) => ({
      id: 'cfg1',
      ...doc,
    }));
    const { req, res } = createMocks({ method: 'POST', query: { id: ORG_ID }, body: {} });
    Object.assign(req, { user: { id: 'owner1', isAdmin: false } });
    try {
      await mockRefs.postHandler!(req, res);
    } finally {
      configKey.value = undefined;
    }

    expect(res._getStatusCode()).toBe(201);
    expect(res._getJSONData().secret).toBe('secret');
    expect(res._getJSONData().secretMasked).toBe('**cret');
  });
});

describe('PUT /api/organizations/[id]/webhooks/github', () => {
  const put = async (body: Record<string, unknown>) => {
    const { req, res } = createMocks({ method: 'PUT', query: { id: ORG_ID }, body });
    Object.assign(req, { user: { id: 'owner1', isAdmin: false } });
    await mockRefs.putHandler!(req, res);
    return res;
  };

  beforeEach(() => {
    orgWebhookConfigRepository.update.mockImplementation(async (partial: Record<string, unknown>) => ({
      id: 'cfg1',
      organizationId: ORG_ID,
      routingToken: 'token',
      repos: [],
      subscribedEvents: [],
      createdBy: 'owner1',
      enabled: true,
      secret: 'enc',
      ...partial,
    }));
  });

  it('writes only enabled when only enabled is sent', async () => {
    const res = await put({ enabled: false });

    expect(res._getStatusCode()).toBe(200);
    expect(orgWebhookConfigRepository.update).toHaveBeenCalledTimes(1);
    expect(orgWebhookConfigRepository.update.mock.calls[0][0]).toStrictEqual({ id: 'cfg1', enabled: false });
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'org.webhook.updated',
        actorScope: 'organization',
        changes: [{ field: 'enabled', before: true, after: false }],
        details: { webhookConfigId: 'cfg1' },
      })
    );
  });

  it('writes only subscribedEvents when only subscribedEvents is sent', async () => {
    await put({ subscribedEvents: ['push'] });

    expect(orgWebhookConfigRepository.update).toHaveBeenCalledTimes(1);
    expect(orgWebhookConfigRepository.update.mock.calls[0][0]).toStrictEqual({
      id: 'cfg1',
      subscribedEvents: ['push'],
    });
  });
});

// The webhook secret and routing token are owner-only: a manager is refused (404, as for a
// stranger) on every method, before any config is read or written.
describe('webhook config is owner-only', () => {
  const orgs = {
    'a roster manager': { userId: 'owner1', adminUserIds: ['mgr'], users: [{ userId: 'mgr' }] },
  };
  const methods = ['getHandler', 'postHandler', 'putHandler', 'deleteHandler'] as const;

  describe.each(Object.entries(orgs))('%s', (_label, org) => {
    it.each(methods)('refuses %s with no config read or write', async handlerKey => {
      organizationRepository.findById.mockResolvedValue({ id: ORG_ID, ...org });
      const { req, res } = createMocks({ method: 'GET', query: { id: ORG_ID }, body: { repos: [] } });
      Object.assign(req, { user: { id: 'mgr', isAdmin: false } });

      await expect(Promise.resolve(mockRefs[handlerKey]!(req, res))).rejects.toThrow(/not found/i);

      expect(orgWebhookConfigRepository.findByOrganizationId).not.toHaveBeenCalled();
      expect(orgWebhookConfigRepository.update).not.toHaveBeenCalled();
    });
  });
});
