// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Config is module-scoped; mock it so tests can control analytics configuration state.
vi.mock('@server/utils/config', () => ({
  Config: {
    B4M_ANALYTICS_ENABLED: 'true',
    OVERWATCH_INGEST_URL: 'https://app.bike4mind.com/api/overwatch/v1/events',
    OVERWATCH_INGEST_KEY: 'b4m_live_testkey1234567890abcdef12345678',
    OVERWATCH_PRODUCT_INGEST_KEYS: '{"widgets":"b4m_live_widgetkey234567890abcdef1234567"}',
    OVERWATCH_PSEUDONYM_SALT: 'aaabbbcccddd0000111122223333444455556666777788889999aaaabbbbcccc0001',
  },
}));

import {
  isAnalyticsConfigured,
  sanitizeReferrer,
  emitActiveEvent,
  emitVisitEvent,
  emitProductEvent,
} from './emitActiveEvent';
import { pseudonymize } from './pseudonymize';
import { OVERWATCH_ANONYMOUS_USER_ID, OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import { Config } from '@server/utils/config';

const CONFIGURED = {
  B4M_ANALYTICS_ENABLED: 'true',
  OVERWATCH_INGEST_URL: 'https://app.bike4mind.com/api/overwatch/v1/events',
  OVERWATCH_INGEST_KEY: 'b4m_live_testkey1234567890abcdef12345678',
  OVERWATCH_PRODUCT_INGEST_KEYS: '{"widgets":"b4m_live_widgetkey234567890abcdef1234567"}',
  OVERWATCH_PSEUDONYM_SALT: 'aaabbbcccddd0000111122223333444455556666777788889999aaaabbbbcccc0001',
};
const WIDGETS_KEY = 'b4m_live_widgetkey234567890abcdef1234567';

function resetConfig() {
  Object.assign(Config, CONFIGURED);
}

function clearConfig() {
  Object.assign(Config as Record<string, string>, {
    B4M_ANALYTICS_ENABLED: 'true',
    OVERWATCH_INGEST_URL: '',
    OVERWATCH_INGEST_KEY: '',
    OVERWATCH_PRODUCT_INGEST_KEYS: '',
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

describe('emitVisitEvent', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ status: 200 });
  });

  it('is a no-op when not configured (fail-open)', async () => {
    await expect(emitVisitEvent({ sessionId: 'visit-1' })).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends a visit with no user identity on it', async () => {
    resetConfig();
    await emitVisitEvent({
      sessionId: 'visit-1',
      referrer: 'https://news.example.com/story',
      utm: { source: 'email' },
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      event: Record<string, unknown>;
    };
    expect(body.event.event).toBe('visit');
    expect(body.event.sessionId).toBe('visit-1');
    expect(body.event.referrer).toBe('https://news.example.com/story');
    expect(body.event.utm).toEqual({ source: 'email' });
    // Anonymous even for a signed-in visitor: a visit count needs an identifier per visit,
    // not a person per visit, and the person is reported by emitActiveEvent instead.
    expect(body.event.userId).toBe(OVERWATCH_ANONYMOUS_USER_ID);
    // No userType either - it is a property of a user, and there is no user here.
    expect('metadata' in body.event).toBe(false);
  });

  it('omits referrer and utm when there are none', async () => {
    resetConfig();
    await emitVisitEvent({ sessionId: 'visit-2' });

    const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      event: Record<string, unknown>;
    };
    expect('referrer' in body.event).toBe(false);
    expect('utm' in body.event).toBe(false);
  });
});

describe('emitProductEvent', () => {
  const mockFetch = vi.fn();
  const sent = () =>
    (JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string) as { event: Record<string, unknown> })
      .event;
  const headerKey = () => ((mockFetch.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>)['x-api-key'];

  beforeEach(() => {
    mockFetch.mockClear();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValue({ status: 200 });
  });

  it('posts under the given product with that product\'s own key', async () => {
    resetConfig();
    await emitProductEvent({ productId: 'widgets', event: 'report_generated', userId: 'user-1', metadata: { status: 'ok' } });

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(headerKey()).toBe(WIDGETS_KEY);
    expect(sent()).toMatchObject({ productId: 'widgets', event: 'report_generated', metadata: { status: 'ok' } });
  });

  it('pseudonymizes the user id with the shared salt, so one person is one user across products', async () => {
    resetConfig();
    await emitProductEvent({ productId: 'widgets', event: 'active', userId: 'user-1' });

    expect(sent().userId).toBe(pseudonymize('user-1', CONFIGURED.OVERWATCH_PSEUDONYM_SALT));
    expect(JSON.stringify(sent())).not.toContain('user-1');
  });

  it('uses the anonymous and no-session sentinels when there is no user or visit', async () => {
    resetConfig();
    await emitProductEvent({ productId: 'widgets', event: 'visit' });

    expect(sent()).toMatchObject({ userId: OVERWATCH_ANONYMOUS_USER_ID, sessionId: OVERWATCH_UNKNOWN_SESSION_ID });
    expect('metadata' in sent()).toBe(false);
  });

  it('carries userType in metadata alongside the caller\'s fields', async () => {
    resetConfig();
    await emitProductEvent({ productId: 'widgets', event: 'active', userId: 'u', userType: 'free', metadata: { runs: 2 } });

    expect(sent().metadata).toEqual({ runs: 2, userType: 'free' });
  });

  it('is a no-op for a product with no key, and for a malformed key map', async () => {
    resetConfig();
    await emitProductEvent({ productId: 'unregistered', event: 'active', userId: 'u' });
    expect(mockFetch).not.toHaveBeenCalled();

    Object.assign(Config as Record<string, string>, { OVERWATCH_PRODUCT_INGEST_KEYS: '{not json' });
    await expect(emitProductEvent({ productId: 'widgets', event: 'active', userId: 'u' })).resolves.toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('never sends the host key for another product', async () => {
    resetConfig();
    Object.assign(Config as Record<string, string>, { OVERWATCH_PRODUCT_INGEST_KEYS: 'not-configured' });
    await emitProductEvent({ productId: 'widgets', event: 'active', userId: 'u' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(isAnalyticsConfigured('widgets')).toBe(false);
    expect(isAnalyticsConfigured()).toBe(true);
  });

  it('logs the product, never the key, on a permanent ingest error', async () => {
    resetConfig();
    mockFetch.mockResolvedValue({ status: 403 });
    const warnSpy = vi.spyOn(console, 'warn');

    await emitProductEvent({ productId: 'widgets', event: 'active', userId: 'u' });

    expect(warnSpy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ productId: 'widgets' }));
    for (const call of warnSpy.mock.calls) expect(JSON.stringify(call)).not.toContain(WIDGETS_KEY);
  });

  it('leaves the host emitters on the host product and key', async () => {
    resetConfig();
    await emitActiveEvent({ pseudoUserId: 'p', sessionId: 's', userType: 'free' });
    expect(sent().productId).toBe('bike4mind');
    expect(headerKey()).toBe(CONFIGURED.OVERWATCH_INGEST_KEY);
  });
});

describe('ingestKeyFor', () => {
  it('returns the host key for the host product and the mapped key for another, else undefined', async () => {
    const { ingestKeyFor } = await import('./emitActiveEvent');
    resetConfig();
    expect(ingestKeyFor('bike4mind')).toBe(CONFIGURED.OVERWATCH_INGEST_KEY);
    expect(ingestKeyFor('widgets')).toBe(WIDGETS_KEY);
    expect(ingestKeyFor('unregistered')).toBeUndefined();
  });
});
