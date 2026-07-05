/**
 * Tests for the build-time-configurable brand defaults.
 *
 * The default endpoint and credits URL are injected at build time via tsdown's
 * `env` option and read from `process.env` at runtime. These tests drive that
 * env directly to cover the hosted default, a custom-URL override, and the
 * unbranded-fork case where the values are unset.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { getApiUrl, getDefaultApiUrl, getCreditsUrl, getEnvironmentName } from './apiUrl';

afterEach(() => {
  delete process.env.B4M_DEFAULT_API_URL;
  delete process.env.B4M_CREDITS_URL;
});

describe('getDefaultApiUrl', () => {
  it('returns the build-time-injected endpoint when set', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(getDefaultApiUrl()).toBe('https://app.bike4mind.com');
  });

  it('returns an empty string for an unbranded fork (unset)', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    expect(getDefaultApiUrl()).toBe('');
  });
});

describe('getApiUrl', () => {
  it('prefers a configured custom URL over the default', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(getApiUrl({ customUrl: 'https://app.example.com' })).toBe('https://app.example.com');
  });

  it('falls back to the build-time default when no custom URL is set', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(getApiUrl(undefined)).toBe('https://app.bike4mind.com');
  });

  it('returns an empty default for an unbranded fork with no custom URL', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    expect(getApiUrl(undefined)).toBe('');
  });
});

describe('getCreditsUrl', () => {
  it('returns the build-time-injected credits page when set', () => {
    process.env.B4M_CREDITS_URL = 'bike4mind.io';
    expect(getCreditsUrl()).toBe('bike4mind.io');
  });

  it('returns an empty string for an unbranded fork (unset)', () => {
    delete process.env.B4M_CREDITS_URL;
    expect(getCreditsUrl()).toBe('');
  });
});

describe('getEnvironmentName', () => {
  it('reads as Production when no custom URL is configured and a default is baked in', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(getEnvironmentName(undefined)).toBe('Production');
  });

  it('reads as Unconfigured when no custom URL and no baked default (unbranded fork)', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    expect(getEnvironmentName(undefined)).toBe('Unconfigured');
  });

  it('reads as Local Dev for a loopback custom URL', () => {
    expect(getEnvironmentName({ customUrl: 'http://localhost:3001' })).toBe('Local Dev');
  });

  it('reads as Self-Hosted for any other custom URL', () => {
    expect(getEnvironmentName({ customUrl: 'https://app.example.com' })).toBe('Self-Hosted');
  });
});
