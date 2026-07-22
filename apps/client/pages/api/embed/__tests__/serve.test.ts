import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

// Unwrap the handler: baseApi({auth:false}).use(rateLimit).get(fn) => fn
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

const mockAgentFindById = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({
  agentRepository: { findById: mockAgentFindById },
}));

// Owner-entitlement resolver mocked at the seam serve.ts calls; the default is
// NOT entitled, so every pre-existing case exercises the branding-shows posture.
const mockOwnerHasEntitlement = vi.hoisted(() => vi.fn());
vi.mock('@server/entitlements/embedKeyEntitlement', () => ({
  embedKeyOwnerHasEntitlement: mockOwnerHasEntitlement,
}));

// Real parseEmbedOrigin from @bike4mind/common - the CSP filter is exercised
// against the actual canonicalizer, not a stub.
import handler from '../serve';

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

function makeReq(query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any).logger = { info: vi.fn(), warn: vi.fn() };
  return { req, res };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function run(query: Record<string, unknown>): Promise<any> {
  const { req, res } = makeReq(query);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (handler as any)(req, res);
  return res;
}

function frameAncestorsOf(res: { getHeader: (h: string) => unknown }): string {
  const csp = String(res.getHeader('Content-Security-Policy') ?? '');
  const directive = csp.split(';').find(d => d.trim().startsWith('frame-ancestors'));
  return directive?.trim() ?? '';
}

describe('GET /api/embed/serve - public widget page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifyEmbedApiKey.mockResolvedValue({ ...VALID_INFO });
    mockAgentFindById.mockResolvedValue({ id: 'agent-1', name: 'Sales Bot' });
    mockOwnerHasEntitlement.mockResolvedValue(false);
  });

  it('renders the agent name into the page config and survives a failed lookup', async () => {
    const named = await run({ k: 'b4m_live_good' });
    expect(named._getData()).toContain('Sales Bot');

    mockAgentFindById.mockRejectedValue(new Error('db down'));
    const fallback = await run({ k: 'b4m_live_good' });
    expect(fallback._getStatusCode()).toBe(200);
    expect(fallback._getData()).not.toContain('Sales Bot');
  });

  it('serves the page with frame-ancestors granting exactly the allow-listed origin', async () => {
    const res = await run({ k: 'b4m_live_good' });
    expect(res._getStatusCode()).toBe(200);
    expect(String(res.getHeader('Content-Type'))).toContain('text/html');
    expect(frameAncestorsOf(res)).toBe("frame-ancestors 'self' https://good.example");
    // The CSP is this page's primary security control - pin every directive, not
    // just frame-ancestors, so a loosened connect-src/base-uri cannot slip through.
    expect(String(res.getHeader('Content-Security-Policy'))).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'self' https://good.example"
    );
  });

  it('joins multiple origins as exact hosts, order preserved, no wildcard', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue({
      ...VALID_INFO,
      allowedOrigins: ['https://a.example', 'https://b.example:8443'],
    });
    const res = await run({ k: 'b4m_live_good' });
    expect(frameAncestorsOf(res)).toBe("frame-ancestors 'self' https://a.example https://b.example:8443");
  });

  it('rejects a missing k with 400 and an unframable error page', async () => {
    const res = await run({});
    expect(res._getStatusCode()).toBe(400);
    expect(String(res.getHeader('Content-Security-Policy'))).toContain("frame-ancestors 'none'");
    expect(mockVerifyEmbedApiKey).not.toHaveBeenCalled();
  });

  it('rejects an empty-string k with 400', async () => {
    const res = await run({ k: '' });
    expect(res._getStatusCode()).toBe(400);
    expect(mockVerifyEmbedApiKey).not.toHaveBeenCalled();
  });

  it('rejects an array-valued k with 400 (param smuggling)', async () => {
    const res = await run({ k: ['a', 'b'] });
    expect(res._getStatusCode()).toBe(400);
    expect(mockVerifyEmbedApiKey).not.toHaveBeenCalled();
  });

  it('returns a uniform 404 for an invalid or revoked key', async () => {
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('Invalid API key'));
    const res = await run({ k: 'b4m_live_revoked' });
    expect(res._getStatusCode()).toBe(404);
    expect(String(res.getHeader('Cache-Control'))).toBe('no-store');
    expect(String(res.getHeader('Content-Security-Policy'))).toContain("frame-ancestors 'none'");
  });

  it('returns the identical 404 for a wrong-scope key (no enumeration signal)', async () => {
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('API key lacks the embed:chat scope'));
    const wrongScope = await run({ k: 'b4m_live_wrongscope' });
    mockVerifyEmbedApiKey.mockRejectedValue(new Error('Invalid API key'));
    const invalid = await run({ k: 'b4m_live_invalid' });
    expect(wrongScope._getStatusCode()).toBe(404);
    expect(wrongScope._getData()).toBe(invalid._getData());
  });

  it('refuses a valid key with no allowedOrigins with 403, unframable', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue({ ...VALID_INFO, allowedOrigins: undefined });
    const res = await run({ k: 'b4m_live_noorigins' });
    expect(res._getStatusCode()).toBe(403);
    expect(String(res.getHeader('Content-Security-Policy'))).toContain("frame-ancestors 'none'");

    mockVerifyEmbedApiKey.mockResolvedValue({ ...VALID_INFO, allowedOrigins: [] });
    const empty = await run({ k: 'b4m_live_noorigins' });
    expect(empty._getStatusCode()).toBe(403);
  });

  it('refuses a key whose stored origins are all non-canonical (filter empties the list)', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue({
      ...VALID_INFO,
      allowedOrigins: ['not-a-valid-origin', 'http://insecure.example'],
    });
    const res = await run({ k: 'b4m_live_junkonly' });
    expect(res._getStatusCode()).toBe(403);
    expect(String(res.getHeader('Content-Security-Policy'))).toContain("frame-ancestors 'none'");
  });

  it('sets the no-leak header set on success', async () => {
    const res = await run({ k: 'b4m_live_good' });
    expect(String(res.getHeader('Cache-Control'))).toBe('private, no-store, must-revalidate');
    expect(String(res.getHeader('X-Content-Type-Options'))).toBe('nosniff');
    expect(String(res.getHeader('Referrer-Policy'))).toBe('no-referrer');
    expect(String(res.getHeader('X-Robots-Tag'))).toBe('noindex, nofollow');
  });

  it('never reflects CORS headers (navigation, not a fetch)', async () => {
    const res = await run({ k: 'b4m_live_good' });
    expect(res.getHeader('Access-Control-Allow-Origin')).toBeUndefined();
    expect(res.getHeader('Vary')).toBeUndefined();
  });

  it('drops CSP-injection-shaped stored origins at the frame-ancestors boundary', async () => {
    // Even if a malformed value reached the stored allow-list, the read-time
    // parseEmbedOrigin re-screen must keep it out of the CSP header - no
    // whitespace/semicolon/newline can smuggle a new directive.
    mockVerifyEmbedApiKey.mockResolvedValue({
      ...VALID_INFO,
      allowedOrigins: [
        'https://ok.example',
        'https://evil.example; script-src *',
        'https://evil.example\n; default-src *',
        "https://evil.example' 'unsafe-inline",
      ],
    });
    const res = await run({ k: 'b4m_live_inject' });
    expect(res._getStatusCode()).toBe(200);
    const csp = String(res.getHeader('Content-Security-Policy'));
    // Only the one canonical origin survives; nothing malformed reaches the header.
    expect(frameAncestorsOf(res)).toBe("frame-ancestors 'self' https://ok.example");
    expect(csp).not.toContain('evil.example');
    expect(csp).not.toContain('script-src *');
    expect(csp).not.toContain('default-src *');
    expect(csp).not.toContain('\n');
    // The re-screen must not have appended any extra directive to the fixed set.
    expect(csp.split(';')).toHaveLength(8);
  });

  it('filters a non-canonical stored origin out of the CSP (read-time re-screen)', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue({
      ...VALID_INFO,
      allowedOrigins: ['https://ok.example', 'not-a-valid-origin', 'http://insecure.example'],
    });
    const res = await run({ k: 'b4m_live_mixed' });
    expect(res._getStatusCode()).toBe(200);
    const fa = frameAncestorsOf(res);
    expect(fa).toBe("frame-ancestors 'self' https://ok.example");
  });

  it('never reflects the key into the page body', async () => {
    const res = await run({ k: 'b4m_live_secret_sauce' });
    const body = res._getData();
    // The key is embedded only inside the escaped config blob, never elsewhere.
    const occurrences = body.split('b4m_live_secret_sauce').length - 1;
    expect(occurrences).toBe(1);
    expect(body).toContain('__B4M_EMBED__');
  });
});

describe('GET /api/embed/serve - white-label branding (epic #41 Phase D)', () => {
  const withBranding = (branding: Record<string, unknown>) => ({ ...VALID_INFO, branding });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('APP_NAME', 'Bike4Mind');
    mockVerifyEmbedApiKey.mockResolvedValue({ ...VALID_INFO });
    mockAgentFindById.mockResolvedValue({ id: 'agent-1', name: 'Sales Bot' });
    mockOwnerHasEntitlement.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers the branding displayName over the agent name', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ displayName: 'Acme Support' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).toContain('Acme Support');
    expect(res._getData()).not.toContain('Sales Bot');
  });

  it('falls back to the agent name for a whitespace-only displayName', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ displayName: '   ' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).toContain('Sales Bot');
  });

  it('widens img-src to exactly the validated logo origin (whole header pinned)', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ logoUrl: 'https://logos.example/acme.png' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(String(res.getHeader('Content-Security-Policy'))).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src data: https://logos.example; base-uri 'none'; " +
        "form-action 'none'; frame-ancestors 'self' https://good.example"
    );
    expect(res._getData()).toContain('https://logos.example/acme.png');
  });

  it('keeps the logo origin port in the CSP grant', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ logoUrl: 'https://logos.example:8443/acme.png' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(String(res.getHeader('Content-Security-Policy'))).toContain('img-src data: https://logos.example:8443;');
  });

  it.each([
    ['javascript: URL', 'javascript:alert(1)'],
    ['data: URL', 'data:image/png;base64,xx'],
    ['http: URL', 'http://logos.example/acme.png'],
    ['empty string', ''],
  ])('does not widen img-src or render a logo for a stored %s', async (_label, logoUrl) => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ logoUrl }));
    const res = await run({ k: 'b4m_live_brand' });
    const csp = String(res.getHeader('Content-Security-Policy'));
    expect(csp).toContain('img-src data:;');
    expect(csp.split(';')).toHaveLength(8);
    // The config JSON must not carry a logoUrl key (the bare cfg.logoUrl
    // reference in the widget JS is always present and not what is asserted).
    expect(res._getData()).not.toContain('"logoUrl"');
    if (logoUrl) expect(res._getData()).not.toContain(logoUrl);
  });

  it('emits the color override style for a valid stored hex color', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ primaryColor: '#AA00FF' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).toContain(':root{--b4m-primary:#aa00ff}');
  });

  it('drops a CSS-injection-shaped stored color entirely', async () => {
    mockVerifyEmbedApiKey.mockResolvedValue(
      withBranding({ primaryColor: '#fff;}body{background:url(//evil.example)' })
    );
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).not.toContain(':root{--b4m-primary');
    expect(res._getData()).not.toContain('evil.example');
  });

  it('hides the powered-by footer only for an entitled owner with hideBranding', async () => {
    mockOwnerHasEntitlement.mockResolvedValue(true);
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ hideBranding: true }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).not.toContain('Powered by');
  });

  it('shows branding for an unentitled owner even when hideBranding is stored true', async () => {
    // THE server-side enforcement the AC requires: the stored flag alone must
    // never hide branding.
    mockOwnerHasEntitlement.mockResolvedValue(false);
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ hideBranding: true }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).toContain('Powered by Bike4Mind');
  });

  it('fails closed to branding-shows when the entitlement resolver rejects', async () => {
    mockOwnerHasEntitlement.mockRejectedValue(new Error('lookup failed'));
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ hideBranding: true }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getStatusCode()).toBe(200);
    expect(res._getData()).toContain('Powered by Bike4Mind');
  });

  it('shows branding for an entitled owner who has not set hideBranding', async () => {
    mockOwnerHasEntitlement.mockResolvedValue(true);
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ displayName: 'Acme' }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).toContain('Powered by Bike4Mind');
  });

  it('never leaks the raw hideBranding flag to the page', async () => {
    mockOwnerHasEntitlement.mockResolvedValue(true);
    mockVerifyEmbedApiKey.mockResolvedValue(withBranding({ hideBranding: true }));
    const res = await run({ k: 'b4m_live_brand' });
    expect(res._getData()).not.toContain('hideBranding');
  });

  it('renders unbranded output byte-identical CSP with no branding stored', async () => {
    const res = await run({ k: 'b4m_live_plain' });
    expect(String(res.getHeader('Content-Security-Policy'))).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'self' https://good.example"
    );
    expect(res._getData()).not.toContain(':root{--b4m-primary');
  });
});
