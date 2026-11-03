// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetSettingsMap } = vi.hoisted(() => ({ mockGetSettingsMap: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  getSettingsMap: mockGetSettingsMap,
}));

import { maskEmail, previewTicket, redeemTicket } from './bedrocknewsTickets';

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

describe('maskEmail', () => {
  it('keeps three characters of the local part', () => {
    expect(maskEmail('victor@bike4mind.com')).toBe('vic…@bike4mind.com');
  });
  it('keeps a short local part whole', () => {
    expect(maskEmail('ab@x.io')).toBe('ab…@x.io');
  });
  it('stays within 80 characters', () => {
    expect(maskEmail(`a@${'d'.repeat(200)}.com`).length).toBeLessThanOrEqual(80);
  });
});

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
    expect(JSON.parse(init.body)).toEqual({ b4mUserId: user.id, b4mAccountLabel: 'vic…@bike4mind.com' });
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
