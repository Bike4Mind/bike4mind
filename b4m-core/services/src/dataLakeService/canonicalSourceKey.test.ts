import { describe, expect, it } from 'vitest';
import { canonicalSourceKey, sanitizeSourceUrlForRecord } from './canonicalSourceKey';

describe('canonicalSourceKey', () => {
  it('lowercases the scheme and the host but never the path or query', () => {
    expect(canonicalSourceKey('HTTPS://Example.COM/Docs/Guide?Q=Alpha')).toBe('https://example.com/Docs/Guide?Q=Alpha');
  });

  it('drops the fragment', () => {
    expect(canonicalSourceKey('https://example.com/a#section-3')).toBe('https://example.com/a');
  });

  it('strips tracking parameters and keeps the meaningful ones', () => {
    expect(canonicalSourceKey('https://example.com/a?id=7&utm_source=x&utm_medium=y&gclid=z&fbclid=w')).toBe(
      'https://example.com/a?id=7'
    );
  });

  it('drops the query string entirely when every parameter was tracking', () => {
    expect(canonicalSourceKey('https://example.com/a?utm_source=x')).toBe('https://example.com/a');
  });

  // `ref`, `referrer` and `source` are resource-identifying on real hosts, so they are NOT stripped.
  // Keying them out merged genuinely distinct sources into one queue entry, and the second one was
  // then answered duplicate_pending and never shown to a human - the silent merge this list exists
  // to avoid. Over-keeping only ever costs a duplicate card someone declines.
  it('keeps parameters that identify a resource rather than a referral', () => {
    const v1 = canonicalSourceKey('https://api.github.com/repos/o/r/contents/p?ref=v1.0');
    const v2 = canonicalSourceKey('https://api.github.com/repos/o/r/contents/p?ref=v2.0');

    expect(v1).toBe('https://api.github.com/repos/o/r/contents/p?ref=v1.0');
    expect(v1).not.toBe(v2);
    expect(canonicalSourceKey('https://example.com/a?source=archive')).toBe('https://example.com/a?source=archive');
    expect(canonicalSourceKey('https://example.com/a?referrer=x')).toBe('https://example.com/a?referrer=x');
  });

  // Kept stripped: unambiguously a share-referral parameter, unlike the three above.
  it('still strips ref_src, which is unambiguously a referral', () => {
    expect(canonicalSourceKey('https://example.com/a?ref_src=twsrc')).toBe('https://example.com/a');
  });

  it('orders the surviving parameters so parameter order is not an identity difference', () => {
    expect(canonicalSourceKey('https://example.com/a?b=2&a=1')).toBe(
      canonicalSourceKey('https://example.com/a?a=1&b=2')
    );
  });

  it('keeps repeated values of the same parameter', () => {
    expect(canonicalSourceKey('https://example.com/a?tag=x&tag=y')).toBe('https://example.com/a?tag=x&tag=y');
  });

  it('drops the default port for the scheme but keeps a non-default one', () => {
    expect(canonicalSourceKey('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalSourceKey('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('strips embedded credentials so a key is never a secret', () => {
    expect(canonicalSourceKey('https://user:pass@example.com/a')).toBe('https://example.com/a');
  });

  it('treats a bare host and its root path as the same source', () => {
    expect(canonicalSourceKey('https://example.com')).toBe(canonicalSourceKey('https://example.com/'));
  });

  it('keeps a trailing slash on a non-root path, which is a different resource', () => {
    expect(canonicalSourceKey('https://example.com/a/')).not.toBe(canonicalSourceKey('https://example.com/a'));
  });

  it('keeps http and https apart - an upgrade is a different origin, not a normalization', () => {
    expect(canonicalSourceKey('http://example.com/a')).not.toBe(canonicalSourceKey('https://example.com/a'));
  });

  it('returns null for a non-HTTP scheme', () => {
    expect(canonicalSourceKey('ftp://example.com/a')).toBeNull();
    expect(canonicalSourceKey('file:///etc/passwd')).toBeNull();
    expect(canonicalSourceKey('javascript:alert(1)')).toBeNull();
  });

  it('returns null for something that is not a URL at all', () => {
    expect(canonicalSourceKey('not a url')).toBeNull();
    expect(canonicalSourceKey('')).toBeNull();
  });
});

describe('sanitizeSourceUrlForRecord', () => {
  it('strips embedded credentials but leaves everything else intact', () => {
    expect(sanitizeSourceUrlForRecord('https://user:pass@example.com/a?utm_source=x#frag')).toBe(
      'https://example.com/a?utm_source=x#frag'
    );
  });

  it('returns a credential-free URL unchanged', () => {
    expect(sanitizeSourceUrlForRecord('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('returns null for an unparseable URL rather than recording a guess', () => {
    expect(sanitizeSourceUrlForRecord('not a url')).toBeNull();
  });
});
