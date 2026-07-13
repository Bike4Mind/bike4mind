import { describe, it, expect } from 'vitest';
import { parseEmbedOrigin, isOriginUnderHost, EmbedOriginsSchema, EMBED_ORIGINS_MAX } from './publishedArtifact';

describe('parseEmbedOrigin', () => {
  it('accepts and canonicalizes an exact https origin', () => {
    expect(parseEmbedOrigin('https://example.com')).toBe('https://example.com');
    expect(parseEmbedOrigin('  HTTPS://Example.COM  ')).toBe('https://example.com');
    expect(parseEmbedOrigin('https://sub.example.com:8443')).toBe('https://sub.example.com:8443');
  });

  it('rejects a non-https scheme (no mixed-content grants)', () => {
    expect(parseEmbedOrigin('http://example.com')).toBeNull();
  });

  it('rejects anything with a path, query, fragment, or userinfo (origin only)', () => {
    expect(parseEmbedOrigin('https://example.com/embed')).toBeNull();
    expect(parseEmbedOrigin('https://example.com/?x=1')).toBeNull();
    expect(parseEmbedOrigin('https://example.com/#frag')).toBeNull();
    expect(parseEmbedOrigin('https://user:pass@example.com')).toBeNull();
  });

  it('allows a bare origin with a trailing slash (canonicalizes it away)', () => {
    expect(parseEmbedOrigin('https://example.com/')).toBe('https://example.com');
  });

  it('rejects wildcards, IP literals, and bare hosts', () => {
    expect(parseEmbedOrigin('https://*.example.com')).toBeNull();
    expect(parseEmbedOrigin('https://1.2.3.4')).toBeNull();
    expect(parseEmbedOrigin('https://[::1]')).toBeNull();
    expect(parseEmbedOrigin('https://localhost')).toBeNull(); // bare label, no TLD
    expect(parseEmbedOrigin('https://example.123')).toBeNull(); // numeric TLD
  });

  it('rejects garbage', () => {
    expect(parseEmbedOrigin('not a url')).toBeNull();
    expect(parseEmbedOrigin('')).toBeNull();
  });
});

describe('isOriginUnderHost', () => {
  it('matches the exact host and its subdomains', () => {
    expect(isOriginUnderHost('https://app.bike4mind.com', 'app.bike4mind.com')).toBe(true);
    expect(isOriginUnderHost('https://pub1.usercontent.app.bike4mind.com', 'app.bike4mind.com')).toBe(true);
    expect(isOriginUnderHost('https://app.bike4mind.com', 'https://app.bike4mind.com')).toBe(true);
  });

  it('does not match an unrelated or suffix-tricked host', () => {
    expect(isOriginUnderHost('https://example.com', 'app.bike4mind.com')).toBe(false);
    expect(isOriginUnderHost('https://notapp.bike4mind.com', 'app.bike4mind.com')).toBe(false);
    expect(isOriginUnderHost('https://app.bike4mind.com.evil.io', 'app.bike4mind.com')).toBe(false);
  });
});

describe('EmbedOriginsSchema', () => {
  it('dedupes, lowercases, and passes a valid list', () => {
    const out = EmbedOriginsSchema.parse(['https://Example.com', 'https://example.com', 'https://b.io']);
    expect(out).toEqual(['https://example.com', 'https://b.io']);
  });

  it('rejects a list with any non-canonical origin', () => {
    expect(() => EmbedOriginsSchema.parse(['https://example.com/path'])).toThrow();
    expect(() => EmbedOriginsSchema.parse(['http://example.com'])).toThrow();
  });

  it(`rejects more than ${EMBED_ORIGINS_MAX} origins`, () => {
    const many = Array.from({ length: EMBED_ORIGINS_MAX + 1 }, (_, i) => `https://s${i}.example.com`);
    expect(() => EmbedOriginsSchema.parse(many)).toThrow();
  });
});
