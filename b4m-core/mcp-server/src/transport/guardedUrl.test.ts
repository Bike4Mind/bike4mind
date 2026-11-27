import { describe, expect, it } from 'vitest';
import { buildGuardedUrl } from './guardedUrl';

const BASE = 'https://app.example.com';
const T = '/api/v1/mcp-confirmations/{id}';

describe('buildGuardedUrl', () => {
  it('resolves and encodes a normal value', () => {
    expect(buildGuardedUrl(BASE, T, { id: 'abc123' })).toBe(`${BASE}/api/v1/mcp-confirmations/abc123`);
    expect(buildGuardedUrl(BASE, T, { id: 'a b?c#d' })).toBe(`${BASE}/api/v1/mcp-confirmations/a%20b%3Fc%23d`);
  });

  it('keeps a base path prefix and appends query', () => {
    expect(buildGuardedUrl(`${BASE}/b4m/`, T, { id: 'x' }, { limit: 5, cursor: undefined })).toBe(
      `${BASE}/b4m/api/v1/mcp-confirmations/x?limit=5`
    );
  });

  it.each([
    ['empty', ''],
    ['dot', '.'],
    ['dot-dot', '..'],
    ['slash', 'a/b'],
    ['backslash', 'a\\b'],
    ['encoded slash', 'a%2Fb'],
    ['encoded slash lower', 'a%2fb'],
    ['encoded backslash', 'a%5Cb'],
    ['encoded dot-dot', '%2e%2e'],
    ['encoded dot', '%2E'],
    ['malformed escape', '%E0%A4%A'],
  ])('refuses %s', (_name, id) => {
    expect(() => buildGuardedUrl(BASE, T, { id })).toThrow(/Invalid path parameter id/);
  });

  it('refuses a missing param', () => {
    expect(() => buildGuardedUrl(BASE, T, {})).toThrow(/Invalid path parameter/);
  });

  it('refuses a base URL with a query or a non-http scheme', () => {
    expect(() => buildGuardedUrl(`${BASE}?x=1`, T, { id: 'a' })).toThrow(/baseUrl/);
    expect(() => buildGuardedUrl('file:///etc', T, { id: 'a' })).toThrow(/baseUrl/);
  });
});
