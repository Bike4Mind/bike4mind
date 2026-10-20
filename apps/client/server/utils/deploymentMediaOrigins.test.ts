import { describe, it, expect, vi } from 'vitest';
import { deploymentMediaOrigins, resolveObjectStoreOrigin } from './deploymentMediaOrigins';

describe('deploymentMediaOrigins', () => {
  it('lists the object store and files origins that are configured', () => {
    expect(
      deploymentMediaOrigins({ S3_PRESIGN_ENDPOINT: 'http://localhost:9000/', SERVER_DOMAIN: 'example.test' })
    ).toEqual(['http://localhost:9000', 'https://files.dev.example.test']);
    expect(deploymentMediaOrigins({})).toEqual([]);
  });

  it('ignores an endpoint that is unsafe for a CSP source list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveObjectStoreOrigin('http://store.test; script-src *')).toBe('');
    expect(resolveObjectStoreOrigin('ftp://store.test')).toBe('');
    warn.mockRestore();
  });
});
