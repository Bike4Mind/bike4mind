// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';

const { mockGetSettingsMap } = vi.hoisted(() => ({ mockGetSettingsMap: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: mockGetSettingsMap,
}));

import { previewTicket, redeemTicket } from './bedrocknewsTickets';

const TICKET = 'abcdefghijklmnopqrstuv';
const BASE = 'https://api.example.com';
const mockFetch = vi.fn();

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  mockFetch.mockReset();
  mockGetSettingsMap.mockResolvedValue({ BedrockNewsApiUrl: BASE, BedrockNewsPartnerKey: 'secret-key' });
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('previewTicket', () => {
  it('sends the partner key and returns the preview', async () => {
    const preview = {
      status: 'open',
      expiresAt: '2026-11-03T12:00:00Z',
      rungs: [{ date: '2026-11-02', length: 5, hard: false }],
    };
    mockFetch.mockResolvedValue(json(200, preview));
    const result = await previewTicket(TICKET);
    expect(result).toEqual({ ok: true, preview });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/headword/partner/tickets/${TICKET}`);
    expect(init.headers['X-Partner-Key']).toBe('secret-key');
  });

  it.each([
    [404, 'TICKET_NOT_FOUND'],
    [410, 'TICKET_EXPIRED'],
    [401, 'PARTNER_KEY_INVALID'],
  ])('passes %s %s through', async (status, code) => {
    mockFetch.mockResolvedValue(json(status, { error: 'x', code }));
    expect(await previewTicket(TICKET)).toEqual({ ok: false, code, status });
  });

  it('answers NOT_CONFIGURED without a request when settings are empty', async () => {
    mockGetSettingsMap.mockResolvedValue({});
    expect(await previewTicket(TICKET)).toEqual({ ok: false, code: 'NOT_CONFIGURED', status: 503 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed ticket id without a request', async () => {
    expect(await previewTicket('../etc/passwd')).toEqual({ ok: false, code: 'TICKET_NOT_FOUND', status: 404 });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('maps a network error or timeout to BEDROCKNEWS_UNAVAILABLE', async () => {
    mockFetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    expect(await previewTicket(TICKET)).toEqual({ ok: false, code: 'BEDROCKNEWS_UNAVAILABLE', status: 502 });
  });

  it('joins a base URL that ends in slashes without doubling them', async () => {
    mockGetSettingsMap.mockResolvedValue({ BedrockNewsApiUrl: `${BASE}//`, BedrockNewsPartnerKey: 'secret-key' });
    mockFetch.mockResolvedValue(json(200, { status: 'open', expiresAt: 'x', rungs: [] }));
    await previewTicket(TICKET);
    expect(mockFetch.mock.calls[0][0]).toBe(`${BASE}/api/headword/partner/tickets/${TICKET}`);
  });

  it('warns with the error name and never the ticket or a partner key the request rejected', async () => {
    const key = 'secret\nkey';
    mockGetSettingsMap.mockResolvedValue({ BedrockNewsApiUrl: BASE, BedrockNewsPartnerKey: key });
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new TypeError(`Invalid header value: "${key}" for ${BASE}/tickets/${TICKET}`));
    await previewTicket(TICKET);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('TypeError');
    expect(logged).not.toContain(TICKET);
    expect(logged).not.toContain(JSON.stringify(key).slice(1, -1));
    expect(logged).not.toContain('secret');
    warn.mockRestore();
  });

  it('names a timeout as the warning reason', async () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    mockFetch.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await previewTicket(TICKET);
    expect(warn.mock.calls[0][1]).toEqual({ name: 'TimeoutError', reason: 'timeout' });
    warn.mockRestore();
  });

  it('trims whitespace pasted around the API URL and partner key', async () => {
    mockGetSettingsMap.mockResolvedValue({ BedrockNewsApiUrl: ` ${BASE}/ \n`, BedrockNewsPartnerKey: ' secret-key\n' });
    mockFetch.mockResolvedValue(json(200, { status: 'open', expiresAt: 'x', rungs: [] }));
    await previewTicket(TICKET);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/headword/partner/tickets/${TICKET}`);
    expect(init.headers['X-Partner-Key']).toBe('secret-key');
  });
});

describe('a success with no JSON body', () => {
  it.each([
    ['empty', ''],
    ['non-JSON', '<html>ok</html>'],
  ])('is BEDROCKNEWS_UNAVAILABLE for an %s 200', async (_label, text) => {
    const unavailable = { ok: false, code: 'BEDROCKNEWS_UNAVAILABLE', status: 502 };
    mockFetch.mockImplementation(async () => new Response(text, { status: 200 }));
    expect(await previewTicket(TICKET)).toEqual(unavailable);
    expect(await redeemTicket(TICKET, { id: 'a1b2c3d4e5f6a1b2c3d4e5f6', email: 'v@x.io' })).toEqual(unavailable);
  });
});

describe('redeemTicket', () => {
  const user = { id: 'a1b2c3d4e5f6a1b2c3d4e5f6', email: 'victor@bike4mind.com' };

  it('posts the user id and masked label with the partner key', async () => {
    const result = { claimed: [], total: 0, balance: 5, firstSolveCredits: 0, capped: 0 };
    mockFetch.mockResolvedValue(json(200, result));
    expect(await redeemTicket(TICKET, user)).toEqual({ ok: true, result });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE}/api/headword/partner/tickets/${TICKET}/redeem`);
    expect(init.method).toBe('POST');
    expect(init.headers['X-Partner-Key']).toBe('secret-key');
    expect(JSON.parse(init.body)).toEqual({ b4mUserId: user.id, b4mAccountLabel: user.email });
  });

  it.each([
    [409, 'CLAIM_IN_PROGRESS'],
    [410, 'TICKET_EXPIRED'],
    [404, 'TICKET_NOT_FOUND'],
    [503, 'B4M_BUDGET_SPENT'],
  ])('passes %s %s through', async (status, code) => {
    mockFetch.mockResolvedValue(json(status, { error: 'x', code }));
    expect(await redeemTicket(TICKET, user)).toEqual({ ok: false, code, status });
  });

  it('maps a network error to BEDROCKNEWS_UNAVAILABLE', async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    expect(await redeemTicket(TICKET, user)).toEqual({ ok: false, code: 'BEDROCKNEWS_UNAVAILABLE', status: 502 });
  });
});
