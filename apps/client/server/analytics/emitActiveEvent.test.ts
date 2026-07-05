// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Config is module-scoped; mock it so tests can control analytics configuration state.
vi.mock('@server/utils/config', () => ({
  Config: {
    B4M_ANALYTICS_ENABLED: 'true',
    OVERWATCH_INGEST_URL: 'https://app.bike4mind.com/api/overwatch/v1/events',
    OVERWATCH_INGEST_KEY: 'b4m_live_testkey1234567890abcdef12345678',
    OVERWATCH_PSEUDONYM_SALT: 'aaabbbcccddd0000111122223333444455556666777788889999aaaabbbbcccc0001',
  },
}));

import { isAnalyticsConfigured, sanitizeReferrer, emitActiveEvent } from './emitActiveEvent';
import { Config } from '@server/utils/config';

const CONFIGURED = {
  B4M_ANALYTICS_ENABLED: 'true',
  OVERWATCH_INGEST_URL: 'https://app.bike4mind.com/api/overwatch/v1/events',
  OVERWATCH_INGEST_KEY: 'b4m_live_testkey1234567890abcdef12345678',
  OVERWATCH_PSEUDONYM_SALT: 'aaabbbcccddd0000111122223333444455556666777788889999aaaabbbbcccc0001',
};

function resetConfig() {
  Object.assign(Config, CONFIGURED);
}

function clearConfig() {
  Object.assign(Config as Record<string, string>, {
    B4M_ANALYTICS_ENABLED: 'true',
    OVERWATCH_INGEST_URL: '',
    OVERWATCH_INGEST_KEY: '',
    OVERWATCH_PSEUDONYM_SALT: '',
  });
}

beforeEach(clearConfig);
afterEach(() => {
  resetConfig();
  vi.restoreAllMocks();
});

describe('isAnalyticsConfigured', () => {
  it('returns false when secrets are empty', () => {
    expect(isAnalyticsConfigured()).toBe(false);
  });

  it('returns false when B4M_ANALYTICS_ENABLED is false', () => {
    Object.assign(Config as Record<string, string>, CONFIGURED, { B4M_ANALYTICS_ENABLED: 'false' });
    expect(isAnalyticsConfigured()).toBe(false);
  });

  it('returns false when any secret is not-configured', () => {
    Object.assign(Config as Record<string, string>, CONFIGURED, { OVERWATCH_INGEST_URL: 'not-configured' });
    expect(isAnalyticsConfigured()).toBe(false);
  });

  it('returns true with all secrets set', () => {
    resetConfig();
    expect(isAnalyticsConfigured()).toBe(true);
  });
});

describe('sanitizeReferrer', () => {
  it('strips query string and fragment', () => {
    expect(sanitizeReferrer('https://example.com/path?token=abc&other=x#hash')).toBe('https://example.com/path');
  });

  it('preserves protocol, host, and pathname', () => {
    expect(sanitizeReferrer('https://example.com/some/path')).toBe('https://example.com/some/path');
  });

  it('returns undefined for an invalid URL', () => {
    expect(sanitizeReferrer('not-a-url')).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(sanitizeReferrer(undefined)).toBeUndefined();
  });
});

describe('emitActiveEvent', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ status: 200 });
  });

  it('is a no-op when not configured (fail-open)', async () => {
    await expect(emitActiveEvent({ pseudoUserId: 'abc', sessionId: 'sid', userType: 'free' })).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the correct payload shape when configured', async () => {
    resetConfig();
    await emitActiveEvent({ pseudoUserId: 'pseudo-123', sessionId: 'sess-abc', userType: 'subscriber' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(CONFIGURED.OVERWATCH_INGEST_URL);

    const body = JSON.parse(calledOpts.body as string) as { event: Record<string, unknown> };
    expect(body.event.productId).toBe('bike4mind');
    expect(body.event.userId).toBe('pseudo-123');
    expect(body.event.sessionId).toBe('sess-abc');
    expect(body.event.event).toBe('active');
    expect(body.event.schemaVersion).toBe(1);
    expect((body.event.metadata as Record<string, string>).userType).toBe('subscriber');
  });

  it('sends x-api-key header and no Authorization header', async () => {
    resetConfig();
    await emitActiveEvent({ pseudoUserId: 'pseudo-123', sessionId: 'sess-abc', userType: 'free' });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, calledOpts] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = calledOpts.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(CONFIGURED.OVERWATCH_INGEST_KEY);
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('does not log the API key on 4xx errors', async () => {
    resetConfig();
    mockFetch.mockResolvedValue({ status: 403 });
    const warnSpy = vi.spyOn(console, 'warn');

    await emitActiveEvent({ pseudoUserId: 'pseudo', sessionId: 'sess', userType: 'free' });

    for (const call of warnSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('b4m_live_');
      expect(serialized).not.toContain(CONFIGURED.OVERWATCH_INGEST_KEY);
    }
  });

  it('warns (without leaking the key) when the ingest URL returns an opaque redirect', async () => {
    resetConfig();
    mockFetch.mockResolvedValue({ status: 0, type: 'opaqueredirect' });
    const warnSpy = vi.spyOn(console, 'warn');

    await emitActiveEvent({ pseudoUserId: 'pseudo', sessionId: 'sess', userType: 'free' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('redirect'),
      expect.objectContaining({ productId: 'bike4mind' })
    );
    for (const call of warnSpy.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('b4m_live_');
      expect(serialized).not.toContain(CONFIGURED.OVERWATCH_INGEST_KEY);
    }
  });

  it('swallows network errors (fail-open)', async () => {
    resetConfig();
    mockFetch.mockRejectedValue(new Error('network failure'));
    await expect(emitActiveEvent({ pseudoUserId: 'p', sessionId: 's', userType: 'free' })).resolves.toBeUndefined();
  });

  it('includes utm and referrer when provided', async () => {
    resetConfig();
    await emitActiveEvent({
      pseudoUserId: 'p',
      sessionId: 's',
      userType: 'free',
      referrer: 'https://example.com/ref',
      utm: { source: 'email', medium: 'newsletter' },
    });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      event: Record<string, unknown>;
    };
    expect(body.event.referrer).toBe('https://example.com/ref');
    expect(body.event.utm).toEqual({ source: 'email', medium: 'newsletter' });
  });

  it('omits referrer and utm when not provided', async () => {
    resetConfig();
    await emitActiveEvent({ pseudoUserId: 'p', sessionId: 's', userType: 'free' });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      event: Record<string, unknown>;
    };
    expect('referrer' in body.event).toBe(false);
    expect('utm' in body.event).toBe(false);
  });
});
