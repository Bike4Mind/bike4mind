import { describe, it, expect } from 'vitest';
import { cookieDomains } from './trackingCookies';

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
