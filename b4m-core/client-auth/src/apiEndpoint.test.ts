import { describe, it, expect } from 'vitest';
import { LOCAL_DEV_URL, parseApiUrl, selectApiEndpoint } from './apiEndpoint';

describe('parseApiUrl', () => {
  it('trims whitespace and strips trailing slashes', () => {
    expect(parseApiUrl('  https://x.com//  ')).toEqual({ url: 'https://x.com' });
  });

  it('rejects an empty, malformed, or non-http(s) URL', () => {
    expect(parseApiUrl('   ')).toEqual({ error: 'Please enter a URL.' });
    expect(parseApiUrl('not a url')).toEqual({ error: 'Invalid URL: not a url' });
    expect(parseApiUrl('ftp://x.com')).toEqual({
      error: 'Only http:// and https:// URLs are supported (got ftp://)',
    });
  });
});

describe('selectApiEndpoint', () => {
  it('prefers a custom URL over the baked default', () => {
    expect(
      selectApiEndpoint({ customUrl: 'https://self.example.com', bakedDefault: 'https://app.example.com' })
    ).toEqual({ status: 'configured', url: 'https://self.example.com', source: 'custom' });
  });

  it('falls back to the baked default, then the dev server', () => {
    expect(selectApiEndpoint({ bakedDefault: 'https://app.example.com', devFallback: true })).toEqual({
      status: 'configured',
      url: 'https://app.example.com',
      source: 'baked-default',
    });
    expect(selectApiEndpoint({ devFallback: true })).toEqual({
      status: 'configured',
      url: LOCAL_DEV_URL,
      source: 'dev-default',
    });
  });

  it('reports unconfigured rather than an empty URL when nothing is set', () => {
    expect(selectApiEndpoint({})).toEqual({ status: 'unconfigured' });
    expect(selectApiEndpoint({ customUrl: '', bakedDefault: '' })).toEqual({ status: 'unconfigured' });
  });
});
