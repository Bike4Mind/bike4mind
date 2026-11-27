// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSignedUrl = vi.hoisted(() => vi.fn());
const getGeneratedImageStorage = vi.hoisted(() => vi.fn(() => ({ getSignedUrl })));
vi.mock('./storage/index', () => ({ getGeneratedImageStorage }));

vi.mock('sst', () => ({ Resource: { JWT_SECRET: { value: 'test-jwt-secret' } } }));

import { verifyGeneratedMediaUrlToken } from './generatedMediaUrlToken';
import { signGeneratedMediaUrls } from './generatedMediaUrls';

const tokenOf = (url: string) => new URL(url, 'http://x.invalid').searchParams.get('t');

const ENV_KEYS = ['AWS_ENDPOINT_URL_S3', 'S3_PRESIGN_ENDPOINT', 'NEXT_PUBLIC_CDN_URL'] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(name => [name, process.env[name]]));

beforeEach(() => {
  vi.clearAllMocks();
  for (const name of ENV_KEYS) delete process.env[name];
  getSignedUrl.mockImplementation(async (key: string) => `https://signed.example.invalid/${key}`);
});

afterEach(() => {
  for (const name of ENV_KEYS) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('signGeneratedMediaUrls', () => {
  it('presigns for the browser audience when no private storage endpoint is configured', async () => {
    process.env.NEXT_PUBLIC_CDN_URL = 'https://cdn.example.invalid';

    const urls = await signGeneratedMediaUrls(['a.png']);

    expect(urls).toEqual({ 'a.png': 'https://signed.example.invalid/a.png' });
    expect(getSignedUrl).toHaveBeenCalledWith('a.png', 'get', { expiresIn: 3600, audience: 'browser' });
  });

  it('serves same-origin proxy urls without touching storage when the endpoint is private', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    process.env.NEXT_PUBLIC_CDN_URL = '/api/app-files/serve//';

    const urls = await signGeneratedMediaUrls(['a.png', 'my file+1.png', 'u/1/x.png']);

    expect(urls['a.png']).toMatch(/^\/api\/app-files\/serve\/generated\/a\.png\?t=[\w-]+\.[\w-]{43}$/);
    expect(urls['my file+1.png']).toMatch(/^\/api\/app-files\/serve\/generated\/my%20file%2B1\.png\?t=/);
    const slashPath = urls['u/1/x.png'].split('?')[0];
    expect(slashPath).toBe('/api/app-files/serve/generated/u%2F1%2Fx.png');
    expect(decodeURIComponent(slashPath.split('/').pop() as string)).toBe('u/1/x.png');
    const now = Math.floor(Date.now() / 1000);
    for (const [key, url] of Object.entries(urls)) {
      expect(verifyGeneratedMediaUrlToken(tokenOf(url), key, now)).toBe(true);
      expect(verifyGeneratedMediaUrlToken(tokenOf(url), `${key}x`, now)).toBe(false);
      expect(verifyGeneratedMediaUrlToken(tokenOf(url), key, now + 3601)).toBe(false);
    }
    expect(getGeneratedImageStorage).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('treats a blank S3_PRESIGN_ENDPOINT as unset', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    process.env.S3_PRESIGN_ENDPOINT = '   ';
    process.env.NEXT_PUBLIC_CDN_URL = '/api/app-files/serve';

    const urls = await signGeneratedMediaUrls(['a.png']);

    expect(urls['a.png']).toContain('/api/app-files/serve/generated/a.png?t=');
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('presigns when a browser-reachable presign endpoint is configured', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    process.env.S3_PRESIGN_ENDPOINT = 'https://files.example.invalid';
    process.env.NEXT_PUBLIC_CDN_URL = '/api/app-files/serve';

    const urls = await signGeneratedMediaUrls(['a.png']);

    expect(urls).toEqual({ 'a.png': 'https://signed.example.invalid/a.png' });
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('presigns when there is no CDN base to build a proxy url from', async () => {
    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';

    await signGeneratedMediaUrls(['a.png']);

    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates keys', async () => {
    const urls = await signGeneratedMediaUrls(['a.png', 'a.png', 'b.png']);

    expect(Object.keys(urls)).toEqual(['a.png', 'b.png']);
    expect(getSignedUrl).toHaveBeenCalledTimes(2);

    process.env.AWS_ENDPOINT_URL_S3 = 'http://minio:9000';
    process.env.NEXT_PUBLIC_CDN_URL = '/api/app-files/serve';
    expect(Object.keys(await signGeneratedMediaUrls(['a.png', 'a.png']))).toEqual(['a.png']);
  });
});
