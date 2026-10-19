// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findByOrganizationId: vi.fn(),
  incrementCounterConditional: vi.fn(),
  verifyOrgAccess: vi.fn(),
  validateTargetUrl: vi.fn(),
  fetchMock: vi.fn(),
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
  orgWebhookConfigRepository: { findByOrganizationId: h.findByOrganizationId },
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { incrementCounterConditional: h.incrementCounterConditional },
}));
vi.mock('@bike4mind/server-utils/security/secretEncryption', () => ({ decryptSecret: () => 'plain-secret' }));
vi.mock('@server/utils/orgAccess', () => ({ verifyOrgAccess: h.verifyOrgAccess }));
vi.mock('@server/utils/ssrfProtection', () => ({ validateTargetUrl: h.validateTargetUrl }));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));

await import('../test');

const TARGET_URL = 'https://hooks.example.com/endpoint';

const makeRes = () => {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
};

const sendTestPing = async () => {
  const res = makeRes();
  const req = {
    query: { id: 'org-1' },
    user: { id: 'user-1' },
    body: { targetUrl: TARGET_URL },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  };
  await h.handler!(req, res);
  return res;
};

const jsonBody = (res: ReturnType<typeof makeRes>) => (res.json.mock.calls as unknown[][])[0][0];

describe('POST /api/organizations/[id]/webhooks/github/test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.incrementCounterConditional.mockResolvedValue({ success: true });
    h.verifyOrgAccess.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    h.findByOrganizationId.mockResolvedValue({ id: 'cfg-1', secret: 'enc(secret)' });
    h.validateTargetUrl.mockResolvedValue({ valid: true });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
    vi.stubGlobal('fetch', h.fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not follow redirects from the target URL', async () => {
    await sendTestPing();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock.mock.calls[0][0]).toBe(TARGET_URL);
    expect(h.fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('reports a redirect response without echoing the endpoint-controlled reason phrase', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 302, statusText: 'secret-reason' });

    const body = jsonBody(await sendTestPing()) as { success: boolean; error: string };

    expect(body.success).toBe(false);
    expect(body.error).toMatch(/redirect/i);
    expect(body.error).not.toContain('secret-reason');
  });

  it('reports a non-redirect failure as the bare status code', async () => {
    h.fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'secret-reason' });

    const body = jsonBody(await sendTestPing()) as { success: boolean; error: string };

    expect(body.success).toBe(false);
    expect(body.error).toBe('HTTP 500');
  });

  it('hides network error details when the target is unreachable', async () => {
    h.fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:80'));

    const body = jsonBody(await sendTestPing()) as { success: boolean; error: string };

    expect(body.success).toBe(false);
    expect(body.error).toBe('Could not reach the target URL');
  });
});
