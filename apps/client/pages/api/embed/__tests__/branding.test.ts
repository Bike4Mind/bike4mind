import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the handler: baseApi({auth:false}).use(rateLimit).get(fn) => fn.
// No embedCors here: the endpoint relies on the platform-level ACAO (see branding.ts),
// so it must not set its own or the two stack into a duplicate the browser rejects.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = { use: () => chain, get: (fn: any) => fn };
    return chain;
  },
}));
vi.mock('@server/middlewares/rateLimit', () => ({ rateLimit: () => () => {} }));

const mockVerifyEmbedApiKey = vi.fn();
vi.mock('@server/cli/auth', () => ({
  verifyEmbedApiKey: (...a: unknown[]) => mockVerifyEmbedApiKey(...a),
}));

// Real parseBrandingColor/parseBrandingDisplayName from @bike4mind/common - the
// launcher must sanitize identically to the widget page, so exercise the actual
// shared helpers, not stubs.
import handler from '../branding';

const VALID_INFO = {
  keyId: 'key-1',
  userId: 'user-1',
  scopes: ['embed:chat'],
  rateLimit: { requestsPerMinute: 10, requestsPerDay: 100 },
  billingOwnerType: 'Organization',
  organizationId: 'org-1',
  agentId: 'agent-1',
  allowedOrigins: ['https://good.example'],
};
const withBranding = (branding: Record<string, unknown>) => ({ ...VALID_INFO, branding });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(query: Record<string, unknown>): Promise<any> {
  const { req, res } = createMocks({ method: 'GET', query });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
  return res;
}

describe('GET /api/embed/branding - launcher branding bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmbedApiKey.mockResolvedValue({ ...VALID_INFO });
  });

  it('returns the sanitized, canonical-lowercase color and display name', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ primaryColor: '#AA00FF', displayName: 'Acme Support' }));
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ primaryColor: '#aa00ff', displayName: 'Acme Support' });
  });

  it('returns an empty object for a key with no branding', async () => {
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({});
  });

  it('omits a stored color that is not strict hex, leaking no injection payload', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(
      withBranding({ primaryColor: '#fff;}body{background:url(//evil.example)' })
    );
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getJSONData().primaryColor).toBeUndefined();
    expect(res._getData()).not.toContain('evil.example');
  });

  it('omits a whitespace-only display name', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ displayName: '   ' }));
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getJSONData().displayName).toBeUndefined();
  });

  it('re-caps a stored display name that predates the write-time length limit', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ displayName: 'Z'.repeat(200) }));
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getJSONData().displayName).toBe('Z'.repeat(64));
  });

  it('rejects a missing, empty, or array-valued k with 400 and never verifies', async () => {
    for (const query of [{}, { k: '' }, { k: ['a', 'b'] }]) {
      const res = await run(query);
      expect(res._getStatusCode()).toBe(400);
      expect(String(res.getHeader('Cache-Control'))).toBe('no-store');
    }
    expect(mockVerifyEmbedApiKey).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 (no-store) for an invalid or revoked key', async () => {
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('Invalid API key'));
    const res = await run({ k: 'b4m_live_revoked' });
    expect(res._getStatusCode()).toBe(404);
    expect(String(res.getHeader('Cache-Control'))).toBe('no-store');
  });

  it('returns the identical 404 body for a wrong-scope key (no enumeration signal)', async () => {
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('API key lacks the embed:chat scope'));
    const wrongScope = await run({ k: 'b4m_live_wrongscope' });
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('Invalid API key'));
    const invalid = await run({ k: 'b4m_live_invalid' });
    expect(wrongScope._getStatusCode()).toBe(404);
    expect(invalid._getStatusCode()).toBe(404);
    expect(wrongScope._getData()).toBe(invalid._getData());
  });

  it('exposes ONLY the cosmetic fields, never other key or branding data', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(
      withBranding({
        primaryColor: '#123',
        displayName: 'Acme',
        logoUrl: 'https://logos.example/a.png',
        hideBranding: true,
      })
    );
    const res = await run({ k: 'b4m_live_good' });
    const body = res._getData();
    for (const leak of ['logoUrl', 'hideBranding', 'agentId', 'organizationId', 'allowedOrigins', 'keyId', 'userId']) {
      expect(body).not.toContain(leak);
    }
    expect(res._getJSONData()).toEqual({ primaryColor: '#123', displayName: 'Acme' });
  });

  it('sets non-cacheable, Origin-varying JSON headers on success', async () => {
    // no-store, not public: the platform ACAO is Origin-conditional with no Vary,
    // so a shared-cached copy could carry the wrong CORS variant (and outlive a
    // key revocation). Vary: Origin is the honest signal.
    const res = await run({ k: 'b4m_live_good' });
    expect(String(res.getHeader('Content-Type'))).toContain('application/json');
    expect(String(res.getHeader('X-Content-Type-Options'))).toBe('nosniff');
    expect(String(res.getHeader('Cache-Control'))).toBe('no-store');
    expect(String(res.getHeader('Vary'))).toBe('Origin');
  });
});
