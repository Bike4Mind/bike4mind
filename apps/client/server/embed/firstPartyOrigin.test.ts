import { describe, expect, it } from 'vitest';
import { isFirstPartyEmbedOrigin } from './firstPartyOrigin';

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
