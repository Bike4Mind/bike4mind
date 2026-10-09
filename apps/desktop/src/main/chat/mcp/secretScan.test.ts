import { describe, expect, it } from 'vitest';
import { looksLikeSecret, scanArgs, scanUrl } from './secretScan';

describe('secret scanning', () => {
  it('flags vendor tokens, JWTs and long random strings', () => {
    expect(looksLikeSecret('ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')).toBeTruthy();
    expect(looksLikeSecret('sk-proj-abcdefghijklmnop')).toBeTruthy();
    expect(looksLikeSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl')).toBeTruthy();
    expect(looksLikeSecret('Q7mZ2xK9pL4vR8tW1yB6nC3hJ5gF0dSa')).toBeTruthy();
  });

  it('leaves paths, packages, versions and commit hashes alone', () => {
    for (const value of [
      '/usr/local/bin/uvx',
      '@scope/some-mcp-server@1.2.3',
      'some-mcp-server',
      '--port',
      '8080',
      'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3',
      'http://localhost:9875/mcp',
    ]) {
      expect(looksLikeSecret(value), value).toBeNull();
    }
  });

  it('flags a token-looking argument by position, without echoing it', () => {
    const flags = scanArgs(['-y', 'some-server', '--api-key', 'abc', 'TOKEN=xyz', 'ghp_a1B2c3D4e5F6g7H8i9J0k1L2']);
    expect(flags.map(flag => flag.where)).toEqual(['argument 4', 'argument 5', 'argument 6']);
    expect(JSON.stringify(flags)).not.toContain('ghp_');
    expect(JSON.stringify(flags)).not.toContain('xyz');
  });

  it('flags a secret in a URL', () => {
    expect(scanUrl('https://example.com/mcp?api_key=abc')).toHaveLength(1);
    expect(scanUrl('https://user:pass@example.com/mcp')).toHaveLength(1);
    expect(scanUrl('https://example.com/mcp')).toEqual([]);
  });
});
