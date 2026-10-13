// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://app.bike4mind.com/"}
import { describe, it, expect, vi, afterEach } from 'vitest';
import { clearTrackingCookies, cookieDomains } from './trackingCookies';

describe('cookieDomains', () => {
  it('walks an app host up to its apex', () => {
    expect(cookieDomains('app.bike4mind.com')).toEqual(['app.bike4mind.com', 'bike4mind.com']);
  });

  it('walks a preview subdomain up to its apex', () => {
    expect(cookieDomains('pr-12.preview.bike4mind.com')).toEqual([
      'pr-12.preview.bike4mind.com',
      'preview.bike4mind.com',
      'bike4mind.com',
    ]);
  });

  it('stops before a shared two-label suffix', () => {
    expect(cookieDomains('d111.cloudfront.net')).toEqual(['d111.cloudfront.net']);
  });

  it.each(['localhost', '10.0.0.5', '[::1]', '::1', 'intranet', ''])('yields nothing for %s', host => {
    expect(cookieDomains(host)).toEqual([]);
  });
});

describe('clearTrackingCookies on a production-like host', () => {
  const FIXED = ['_fbp', '_fbc', '_rdt_uuid', '_rdt_em', '_rdt_cid', '_ga', '_gcl_au'];
  const proto = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')!;

  afterEach(() => {
    vi.restoreAllMocks();
    for (const entry of document.cookie.split('; ')) {
      const name = entry.split('=')[0];
      if (name)
        proto.set!.call(document, `${name}=; path=/; domain=bike4mind.com; expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    }
  });

  function spyOnWrites(): string[] {
    const writes: string[] = [];
    vi.spyOn(document, 'cookie', 'set').mockImplementation(value => {
      writes.push(value);
      proto.set!.call(document, value);
    });
    return writes;
  }

  it('runs on the production host', () => {
    expect(window.location.hostname).toBe('app.bike4mind.com');
  });

  it('writes apex and host expiries, with and without the leading dot, for every cookie name', () => {
    document.cookie = '_ga_ABC123=x; path=/; domain=bike4mind.com';
    const writes = spyOnWrites();

    clearTrackingCookies();

    for (const name of [...FIXED, '_ga_ABC123']) {
      for (const suffix of [
        'domain=bike4mind.com',
        'domain=.bike4mind.com',
        'domain=app.bike4mind.com',
        'domain=.app.bike4mind.com',
      ]) {
        expect(writes.some(w => w.startsWith(`${name}=; path=/; ${suffix}; expires=Thu, 01 Jan 1970`))).toBe(true);
      }
    }
  });

  it('removes apex-scoped cookies and leaves unrelated ones', () => {
    for (const name of [...FIXED, '_ga_ABC123', 'unrelated'])
      document.cookie = `${name}=x; path=/; domain=bike4mind.com`;
    expect(document.cookie.split('; ')).toHaveLength(FIXED.length + 2);

    clearTrackingCookies();

    expect(document.cookie).toBe('unrelated=x');
  });
});
