// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectsApiRateLimitEnforcement, isSharedRealEnv } from '../e2e/helpers/env';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rate-limit E2E target runtime', () => {
  it.each([
    'http://localhost:3000',
    'http://LOCALHOST.:3000',
    'http://app.localhost:3000',
    'http://127.0.0.1:3000',
    'http://127.0.1.1:3000',
    'http://127.1:3000',
    'http://[::1]:3000',
  ])('defaults loopback target %s to the development bypass', url => {
    vi.stubEnv('E2E_API_RUNTIME', undefined);
    expect(expectsApiRateLimitEnforcement(url, undefined)).toBe(false);
    expect(expectsApiRateLimitEnforcement(url, 'production')).toBe(true);
  });

  it('defaults a remote preview to production without inspecting a failed assertion', () => {
    vi.stubEnv('E2E_API_RUNTIME', undefined);
    expect(expectsApiRateLimitEnforcement('https://app.pr7293.preview.bike4mind.com', undefined)).toBe(true);
    expect(expectsApiRateLimitEnforcement('https://target.invalid', 'development')).toBe(false);
  });

  it('fails on an unknown configured runtime', () => {
    expect(() => expectsApiRateLimitEnforcement('http://localhost:3000', 'typo')).toThrow();
  });

  it.each(['https://app.staging.bike4mind.com', 'https://app.bike4mind.com'])(
    'preserves the separate shared-target mutation guard for %s',
    url => {
      expect(isSharedRealEnv(url)).toBe(true);
    }
  );
});
