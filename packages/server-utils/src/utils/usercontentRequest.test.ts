import { describe, it, expect } from 'vitest';
import { allowsUsercontentRequest } from './usercontentRequest';

describe('usercontent origin boundary', () => {
  const host = 'pub1.usercontent.app.example.com';
  it.each([
    '/login',
    '/',
    '/api/auth/login',
    '/api/publish/widget',
    '/_next/image',
    '/public/test.html',
    '/p/u/id/slug',
  ])('refuses %s', pathname => {
    expect(allowsUsercontentRequest(host, pathname, 'GET', 'example.com')).toBe(false);
  });
  it('admits only read requests for bundles and their assets', () => {
    expect(allowsUsercontentRequest(host, '/uc/u/id/slug', 'GET', 'example.com')).toBe(true);
    expect(allowsUsercontentRequest(host, '/uc/u/id/slug/img.png', 'HEAD', 'example.com')).toBe(true);
    expect(allowsUsercontentRequest(host, '/uc/u/id/slug', 'POST', 'example.com')).toBe(false);
  });
  it('handles host case, ports, trailing dots and invalid artifact labels', () => {
    for (const value of [host.toUpperCase(), `${host}:443`, `${host}.`]) {
      expect(allowsUsercontentRequest(value, '/login', 'GET', 'example.com')).toBe(false);
    }
    expect(
      allowsUsercontentRequest('other.pub1.usercontent.app.example.com', '/uc/u/id/slug', 'GET', 'example.com')
    ).toBe(false);
    expect(allowsUsercontentRequest('usercontent.app.example.com', '/login', 'GET', 'example.com')).toBe(false);
  });
  it('preserves app and self-host routes', () => {
    expect(allowsUsercontentRequest('app.example.com', '/login', 'POST', 'example.com')).toBe(true);
    expect(allowsUsercontentRequest('localhost:3000', '/login', 'GET', '')).toBe(true);
  });
});
