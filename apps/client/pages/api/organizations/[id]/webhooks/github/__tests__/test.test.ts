// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  handler: null as null | ((req: unknown, res: unknown) => Promise<unknown>),
  findByOrganizationId: vi.fn(),
  incrementCounterConditional: vi.fn(),
  verifyOrgOwner: vi.fn(),
  validateTargetUrl: vi.fn(),
  fetchMock: vi.fn(),
  SsrfError: class SsrfError extends Error {},
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
vi.mock('@bike4mind/server-utils/utils/orgAccess', () => ({ verifyOrgOwner: h.verifyOrgOwner }));
vi.mock('@bike4mind/server-utils/utils/ssrfProtection', () => ({
  validateTargetUrl: h.validateTargetUrl,
  fetchPinned: h.fetchMock,
  SsrfError: h.SsrfError,
}));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'test-key' } }));

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
    h.verifyOrgOwner.mockResolvedValue({ id: 'org-1', name: 'Acme' });
    h.findByOrganizationId.mockResolvedValue({ id: 'cfg-1', secret: 'enc(secret)' });
    h.validateTargetUrl.mockResolvedValue({ valid: true });
    h.fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends through the pinned fetch with plain http allowed, not global fetch', async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal('fetch', globalFetch);

    await sendTestPing();

    expect(h.fetchMock).toHaveBeenCalledWith(TARGET_URL, expect.objectContaining({ method: 'POST' }), {
      allowHttp: true,
      discardBody: true,
    });
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it('rejects the request when the pinned fetch refuses the dialed address', async () => {
    h.fetchMock.mockRejectedValue(new h.SsrfError('Blocked connection to a private address for x'));

    await expect(sendTestPing()).rejects.toThrow('Blocked connection to a private address');
  });

  it('does not follow redirects from the target URL', async () => {
    await sendTestPing();

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.fetchMock.mock.calls[0][0]).toBe(TARGET_URL);
    expect(h.fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('reports success for a 200 with a large response body and cancels the body', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull: c => c.enqueue(new Uint8Array(1024)), cancel });
    h.fetchMock.mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })
    );

    const body = jsonBody(await sendTestPing()) as { success: boolean; statusCode: number };

    expect(cancel).toHaveBeenCalled();
    expect(body).toMatchObject({ success: true, statusCode: 200 });
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
