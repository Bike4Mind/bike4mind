import { afterEach, describe, expect, it, vi } from 'vitest';
import { signedUrlExpiresAt } from './signedUrlExpiry';

describe('signedUrlExpiresAt', () => {
  const signedAt = new Date('2026-01-02T03:04:05Z');
  const sigV4Url = (expiresSeconds: number) =>
    `https://bucket.example.invalid/owned/file.txt?X-Amz-Date=20260102T030405Z&X-Amz-Expires=${expiresSeconds}`;

  afterEach(() => vi.useRealTimers());

  it('caches the lifetime the signer actually granted when it was clamped to its credentials', () => {
    vi.useFakeTimers({ now: signedAt });
    expect(signedUrlExpiresAt(sigV4Url(19 * 60), 3600)).toEqual(new Date(signedAt.getTime() + 19 * 60 * 1000));
  });

  it('caches the requested lifetime for an unclamped SigV4 URL', () => {
    vi.useFakeTimers({ now: signedAt });
    expect(signedUrlExpiresAt(sigV4Url(3600), 3600)).toEqual(new Date(signedAt.getTime() + 3600 * 1000));
  });

  it('caps a multi-day link at an hour, since its credentials may expire without saying so', () => {
    vi.useFakeTimers({ now: signedAt });
    const fiveDays = 5 * 24 * 3600;
    expect(signedUrlExpiresAt(sigV4Url(fiveDays), fiveDays)).toEqual(new Date(signedAt.getTime() + 3600 * 1000));
    expect(signedUrlExpiresAt('https://files.example.invalid/owned/file.txt', fiveDays)).toEqual(
      new Date(signedAt.getTime() + 3600 * 1000)
    );
  });

  it.each([
    ['carries no SigV4 query (non-S3 adapter)', 'https://files.example.invalid/owned/file.txt'],
    ['is not a URL', 'not a url'],
    ['has a malformed X-Amz-Date', 'https://b.example.invalid/f?X-Amz-Date=yesterday&X-Amz-Expires=60'],
  ])('falls back to the requested lifetime when the URL %s', (_label, url) => {
    vi.useFakeTimers({ now: signedAt });
    expect(signedUrlExpiresAt(url, 3600)).toEqual(new Date(signedAt.getTime() + 3600 * 1000));
  });
});
