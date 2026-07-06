/**
 * Tests for the build-time-configurable brand defaults.
 *
 * The default endpoint and credits URL are injected at build time via tsdown's
 * `env` option and read from `process.env` at runtime. These tests drive that
 * env directly to cover the hosted default, a custom-URL override, and the
 * unbranded-fork case where the values are unset.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveApiEndpoint,
  requireApiUrl,
  ApiEndpointUnconfiguredError,
  getDefaultApiUrl,
  getCreditsUrl,
  getEnvironmentName,
  parseApiUrl,
} from './apiUrl';

afterEach(() => {
  delete process.env.B4M_DEFAULT_API_URL;
  delete process.env.B4M_CREDITS_URL;
  delete process.env.B4M_SOURCE_MODE;
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

describe('resolveApiEndpoint', () => {
  it('prefers a configured custom URL over the default, tagged as custom', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(resolveApiEndpoint({ customUrl: 'https://app.example.com' })).toEqual({
      status: 'configured',
      url: 'https://app.example.com',
      source: 'custom',
    });
  });

  it('falls back to the build-time default, tagged as baked-default', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(resolveApiEndpoint(undefined)).toEqual({
      status: 'configured',
      url: 'https://app.bike4mind.com',
      source: 'baked-default',
    });
  });

  it('is unconfigured for a published unbranded fork with no custom URL', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    delete process.env.B4M_SOURCE_MODE;
    expect(resolveApiEndpoint(undefined)).toEqual({ status: 'unconfigured' });
  });

  it('is unconfigured when a custom URL is an empty string', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    delete process.env.B4M_SOURCE_MODE;
    expect(resolveApiEndpoint({ customUrl: '' })).toEqual({ status: 'unconfigured' });
  });

  it('falls back to the local dev server in source mode when nothing else is set', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    process.env.B4M_SOURCE_MODE = '1';
    expect(resolveApiEndpoint(undefined)).toEqual({
      status: 'configured',
      url: 'http://localhost:3001',
      source: 'dev-default',
    });
  });

  it('prefers a baked default over the source-mode dev fallback', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    process.env.B4M_SOURCE_MODE = '1';
    expect(resolveApiEndpoint(undefined)).toEqual({
      status: 'configured',
      url: 'https://app.bike4mind.com',
      source: 'baked-default',
    });
  });

  it('prefers a custom URL over the source-mode dev fallback', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    process.env.B4M_SOURCE_MODE = '1';
    expect(resolveApiEndpoint({ customUrl: 'https://app.example.com' })).toEqual({
      status: 'configured',
      url: 'https://app.example.com',
      source: 'custom',
    });
  });
});

describe('requireApiUrl', () => {
  it('returns the configured URL', () => {
    process.env.B4M_DEFAULT_API_URL = 'https://app.bike4mind.com';
    expect(requireApiUrl(undefined)).toBe('https://app.bike4mind.com');
    expect(requireApiUrl({ customUrl: 'https://app.example.com' })).toBe('https://app.example.com');
  });

  it('throws an actionable ApiEndpointUnconfiguredError when unconfigured', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    expect(() => requireApiUrl(undefined)).toThrow(ApiEndpointUnconfiguredError);
    // The message must point the developer at how to configure an endpoint.
    expect(() => requireApiUrl(undefined)).toThrow(/--api-url/);
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

  it('reads as Unconfigured when no custom URL and no baked default (published unbranded fork)', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    delete process.env.B4M_SOURCE_MODE;
    expect(getEnvironmentName(undefined)).toBe('Unconfigured');
  });

  it('reads as Local Dev for the source-mode dev fallback', () => {
    delete process.env.B4M_DEFAULT_API_URL;
    process.env.B4M_SOURCE_MODE = '1';
    expect(getEnvironmentName(undefined)).toBe('Local Dev');
  });

  it('reads as Local Dev for a loopback custom URL', () => {
    expect(getEnvironmentName({ customUrl: 'http://localhost:3001' })).toBe('Local Dev');
  });

  it('reads as Self-Hosted for any other custom URL', () => {
    expect(getEnvironmentName({ customUrl: 'https://app.example.com' })).toBe('Self-Hosted');
  });
});

describe('parseApiUrl', () => {
  it('accepts an http(s) URL and strips trailing slashes and surrounding whitespace', () => {
    expect(parseApiUrl('https://app.example.com/')).toEqual({ url: 'https://app.example.com' });
    expect(parseApiUrl('  http://localhost:3000  ')).toEqual({ url: 'http://localhost:3000' });
  });

  it('rejects an empty input', () => {
    expect(parseApiUrl('   ')).toEqual({ error: 'Please enter a URL.' });
  });

  it('rejects a malformed URL', () => {
    expect(parseApiUrl('not a url')).toHaveProperty('error');
  });

  it('rejects a non-http(s) protocol', () => {
    const result = parseApiUrl('ftp://example.com');
    expect('error' in result && result.error).toMatch(/http/);
  });
});
