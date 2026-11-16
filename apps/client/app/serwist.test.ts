import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@serwist/turbopack/react', () => ({ SerwistProvider: () => null }));
import { SerwistProvider } from './serwist';

afterEach(() => vi.unstubAllEnvs());

describe('service worker registration', () => {
  it('disables the worker in development so cached chunks cannot cross dev builds', () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(SerwistProvider({ swUrl: '/serwist/sw.js', disable: false }).props.disable).toBe(true);
  });

  it('preserves production registration and explicit disabling', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(SerwistProvider({ swUrl: '/serwist/sw.js' }).props.disable).toBeUndefined();
    expect(SerwistProvider({ swUrl: '/serwist/sw.js', disable: true }).props.disable).toBe(true);
  });
});
