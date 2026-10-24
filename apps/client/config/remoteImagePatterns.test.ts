import { describe, it, expect } from 'vitest';
import { buildRemoteImagePatterns } from './remoteImagePatterns.mjs';

describe('image optimizer origins', () => {
  it('has no wildcard buckets, branded fallback or unrestricted GitHub proxy', () => {
    expect(buildRemoteImagePatterns({})).toEqual([{ protocol: 'https', hostname: 'avatars.githubusercontent.com' }]);
  });
  it('resolves exact deployment bucket and CDN hosts', () => {
    expect(
      buildRemoteImagePatterns({
        GENERATED_IMAGES_BUCKET_NAME: 'own-images',
        AWS_REGION: 'eu-west-1',
        NEXT_PUBLIC_CDN_URL: 'https://files.example.com',
      })
    ).toEqual(
      expect.arrayContaining([
        { protocol: 'https', hostname: 'own-images.s3.eu-west-1.amazonaws.com' },
        { protocol: 'https', hostname: 'files.example.com' },
      ])
    );
  });
  it('supports relative local file proxies and fails closed on wildcard configuration', () => {
    expect(buildRemoteImagePatterns({ NEXT_PUBLIC_CDN_URL: '/api/app-files/serve' })).toHaveLength(1);
    expect(() => buildRemoteImagePatterns({ GENERATED_IMAGES_BUCKET_NAME: '*-images' })).toThrow();
    expect(() => buildRemoteImagePatterns({ NEXT_PUBLIC_CDN_URL: 'https://*.example.com' })).toThrow();
  });
});
