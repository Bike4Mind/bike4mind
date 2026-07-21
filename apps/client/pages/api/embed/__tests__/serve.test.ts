import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    const csp = String(res.getHeader('Content-Security-Policy'));
    expect(csp).not.toContain('*');
    expect(csp).not.toContain('evil.example');
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
