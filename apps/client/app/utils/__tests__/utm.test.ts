import { describe, it, expect } from 'vitest';
import { extractUtmCampaign } from '../utm';

describe('extractUtmCampaign', () => {
  it('returns utm_campaign slug from a full URL', () => {
    expect(extractUtmCampaign('https://example.com/?utm_source=reddit&utm_campaign=news_v3')).toBe('news_v3');
  });

  it('lowercases mixed-case utm_campaign values', () => {
    expect(extractUtmCampaign('https://example.com/?utm_campaign=News_v3')).toBe('news_v3');
  });

  it('returns null when utm_campaign param is absent', () => {
    expect(extractUtmCampaign('https://example.com/?utm_source=reddit')).toBeNull();
  });

  it('returns null for malformed URLs without throwing', () => {
    expect(extractUtmCampaign('https:/')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractUtmCampaign('')).toBeNull();
  });

  it('returns decoded and lowercased value for percent-encoded utm_campaign', () => {
    expect(extractUtmCampaign('https://example.com/?utm_campaign=hello%20world')).toBe('hello world');
  });

  it('returns null for whitespace-only utm_campaign value', () => {
    expect(extractUtmCampaign('https://example.com/?utm_campaign=%20%20')).toBeNull();
  });
});
