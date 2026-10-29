import { describe, expect, it } from 'vitest';
import { isFirstPartyEmbedOrigin, resolveEmbedOriginDecision } from './firstPartyOrigin';

describe('isFirstPartyEmbedOrigin', () => {
  it('permits an origin equal to the publish host', () => {
    expect(isFirstPartyEmbedOrigin('https://app.example.com', undefined, 'app.example.com')).toBe(true);
  });

  it('rejects a subdomain under the publish host (exact match only)', () => {
    // Subtree trust would include untrusted customer bundles served from
    // {publicId}.usercontent.app.<domain>; only the exact app host is first-party.
    expect(isFirstPartyEmbedOrigin('https://sub.app.example.com', undefined, 'app.example.com')).toBe(false);
  });

  it('rejects a usercontent bundle origin under the app host', () => {
    expect(isFirstPartyEmbedOrigin('https://abc123.usercontent.app.example.com', undefined, 'app.example.com')).toBe(
      false
    );
  });

  it('rejects a third-party origin regardless of publish host', () => {
    expect(isFirstPartyEmbedOrigin('https://evil.com', undefined, 'app.example.com')).toBe(false);
  });

  it('rejects a suffix-lookalike host (not a dot-boundary subdomain)', () => {
    expect(isFirstPartyEmbedOrigin('https://evilapp.example.com.attacker.com', undefined, 'app.example.com')).toBe(
      false
    );
  });

  it('falls back to the request Host when publish host is empty (local/dev)', () => {
    expect(isFirstPartyEmbedOrigin('http://localhost:3000', 'localhost:3000', '')).toBe(true);
    expect(isFirstPartyEmbedOrigin('http://localhost:3000', 'localhost:4000', '')).toBe(false);
  });

  it('host fallback is case-insensitive and port-sensitive', () => {
    expect(isFirstPartyEmbedOrigin('http://LocalHost:3000', 'localhost:3000', '')).toBe(true);
    expect(isFirstPartyEmbedOrigin('https://app.example.com', 'app.example.com', '')).toBe(true);
  });

  it('rejects a malformed origin and a missing request host', () => {
    expect(isFirstPartyEmbedOrigin('not-a-url', 'localhost:3000', '')).toBe(false);
    expect(isFirstPartyEmbedOrigin('https://app.example.com', undefined, '')).toBe(false);
  });
});

describe('resolveEmbedOriginDecision', () => {
  const allowed = ['https://host.example.com'];

  it('allows a request with no Origin header', () => {
    expect(resolveEmbedOriginDecision(undefined, allowed, 'app.example.com')).toBe(true);
  });

  it('denies an opaque origin when the key restricts origins', () => {
    expect(resolveEmbedOriginDecision('null', allowed, 'app.example.com')).toBe(false);
  });

  it('denies an opaque origin when the key lists no origins', () => {
    expect(resolveEmbedOriginDecision('null', [], 'app.example.com')).toBe(false);
    expect(resolveEmbedOriginDecision('null', undefined, 'app.example.com')).toBe(false);
  });

  it('allows a request with no Origin header when the key lists no origins', () => {
    expect(resolveEmbedOriginDecision(undefined, [], 'app.example.com')).toBe(true);
    expect(resolveEmbedOriginDecision(undefined, undefined, 'app.example.com')).toBe(true);
  });

  it('applies the allow-list and first-party rules to any other origin', () => {
    expect(resolveEmbedOriginDecision('https://host.example.com', allowed, 'app.example.com')).toBe(true);
    expect(resolveEmbedOriginDecision('https://other.example.com', allowed, 'app.example.com')).toBe(false);
    expect(resolveEmbedOriginDecision('http://localhost:3000', allowed, 'localhost:3000')).toBe(true);
  });
});
