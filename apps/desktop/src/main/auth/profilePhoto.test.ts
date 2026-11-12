import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import { MediaStore } from '../chat/media/MediaStore';
import {
  fetchProfilePhoto,
  ProfilePhotoCache,
  profilePhotoCacheKey,
  resolveProfilePhotoUrl,
  type PhotoRecordFile,
} from './profilePhoto';

const KEY = 'profile-photos/user-1/aaaa.png';
const silentLogger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

function memoryRecord(): PhotoRecordFile {
  let contents: string | null = null;
  return {
    async read() {
      return contents;
    },
    async write(next: string) {
      contents = next;
    },
    async remove() {
      contents = null;
    },
  };
}

async function cache(): Promise<ProfilePhotoCache> {
  const base = await mkdtemp(join(tmpdir(), 'b4m-profile-photo-'));
  return new ProfilePhotoCache(new MediaStore(base), memoryRecord());
}

/** A one-pixel PNG is enough: MediaStore only cares that the bytes are non-empty. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

function apiReturning(body: unknown, contentType: string): AuthenticatedApiClient {
  return {
    getAxiosInstance: () => ({
      get: vi.fn().mockResolvedValue({ data: body, headers: { 'content-type': contentType } }),
    }),
  } as unknown as AuthenticatedApiClient;
}

describe('profilePhotoCacheKey', () => {
  it('changes when the upload does, because the key carries the upload uuid', () => {
    expect(profilePhotoCacheKey('user-1', 'profile-photos/user-1/aaaa.png')).not.toBe(
      profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png')
    );
  });

  it('separates two accounts that share a photo source', () => {
    expect(profilePhotoCacheKey('user-1', 'https://cdn.example.com/legacy.png')).not.toBe(
      profilePhotoCacheKey('user-2', 'https://cdn.example.com/legacy.png')
    );
  });

  it('is stable for the same account and upload', () => {
    expect(profilePhotoCacheKey('user-1', KEY)).toBe(profilePhotoCacheKey('user-1', KEY));
  });
});

describe('resolveProfilePhotoUrl', () => {
  it('joins a bucket key onto an absolute CDN base', () => {
    expect(resolveProfilePhotoUrl(KEY, 'https://cdn.example.com/')).toBe(`https://cdn.example.com/${KEY}`);
  });

  it('joins a bucket key onto the self-host proxy path', () => {
    expect(resolveProfilePhotoUrl(KEY, '/api/app-files/serve')).toBe(`/api/app-files/serve/${KEY}`);
  });

  it('passes an already-absolute source through untouched', () => {
    expect(resolveProfilePhotoUrl('https://example.com/me.jpg', '')).toBe('https://example.com/me.jpg');
  });

  it('gives up on a key when the deployment advertises no CDN base', () => {
    expect(resolveProfilePhotoUrl(KEY, '')).toBeNull();
  });
});

describe('ProfilePhotoCache', () => {
  it('can store a new account photo after clearing the same cache instance', async () => {
    const store = await cache();
    await store.store('account-a', PNG, 'image/png');
    await store.clear();
    const url = await store.store('account-b', PNG, 'image/png');
    expect(await store.lookup('account-a')).toBeNull();
    expect(await store.lookup('account-b')).toBe(url);
  });

  it.each(['media', 'sidecar'])('waits for an active %s write before completing sign-out cleanup', async stage => {
    const base = await mkdtemp(join(tmpdir(), 'b4m-profile-photo-race-'));
    const media = new MediaStore(base);
    const record = memoryRecord();
    const store = new ProfilePhotoCache(media, record);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => {
      enter = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    if (stage === 'media') {
      const save = media.save.bind(media);
      vi.spyOn(media, 'save').mockImplementation(async (...args) => {
        enter();
        await gate;
        return save(...args);
      });
    } else {
      const write = record.write.bind(record);
      vi.spyOn(record, 'write').mockImplementation(async contents => {
        enter();
        await gate;
        await write(contents);
      });
    }
    const outcome = store.store('account-a', PNG, 'image/png').catch((error: unknown) => error);
    await entered;
    let cleared = false;
    const clearing = store.clear().then(() => {
      cleared = true;
    });
    await Promise.resolve();
    expect(cleared).toBe(false);
    release();
    expect(await outcome).toBeInstanceOf(Error);
    await clearing;
    expect(await record.read()).toBeNull();
    expect(await readdir(base)).toEqual([]);
  });

  it('invalidates queued pre-sign-out stores and accepts a later account', async () => {
    const store = await cache();
    const first = store.store('old-a', PNG, 'image/png').catch((error: unknown) => error);
    const second = store.store('old-b', PNG, 'image/png').catch((error: unknown) => error);
    const clearing = store.clear();
    const next = store.store('new-account', PNG, 'image/png');
    expect(await first).toBeInstanceOf(Error);
    expect(await second).toBeInstanceOf(Error);
    await clearing;
    expect(await store.lookup('new-account')).toBe(await next);
    expect(await store.lookup('old-a')).toBeNull();
  });

  it('does not poison cleanup or the next store when a write fails', async () => {
    const media = new MediaStore(await mkdtemp(join(tmpdir(), 'b4m-profile-photo-failure-')));
    const record = memoryRecord();
    const store = new ProfilePhotoCache(media, record);
    vi.spyOn(record, 'write').mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(store.store('old', PNG, 'image/png')).rejects.toThrow('disk unavailable');
    await store.clear();
    const url = await store.store('new', PNG, 'image/png');
    expect(await store.lookup('new')).toBe(url);
  });

  it('returns the stored url for the key it was stored under', async () => {
    const store = await cache();
    const url = await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');

    expect(url).toMatch(/^b4m-media:\/\/media\/profile-photo\//);
    await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBe(url);
  });

  it('misses when the photo has been replaced', async () => {
    const store = await cache();
    await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');

    await expect(store.lookup(profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png'))).resolves.toBeNull();
  });

  it('keeps only the newest photo on disk', async () => {
    const store = await cache();
    const first = await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');
    const second = await store.store(
      profilePhotoCacheKey('user-1', 'profile-photos/user-1/bbbb.png'),
      PNG,
      'image/png'
    );

    expect(second).not.toBe(first);
    await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
  });

  it('leaves nothing behind after a sign-out', async () => {
    const store = await cache();
    await store.store(profilePhotoCacheKey('user-1', KEY), PNG, 'image/png');
    await store.clear();

    await expect(store.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
  });
});

describe('fetchProfilePhoto', () => {
  const request = async (api: AuthenticatedApiClient, cdnUrl = '/api/app-files/serve') => ({
    api,
    cache: await cache(),
    logger: silentLogger,
    userId: 'user-1',
    source: KEY,
    cdnUrl,
  });

  it('stores an image response and hands back a local url', async () => {
    const url = await fetchProfilePhoto(await request(apiReturning(PNG, 'image/png')));
    expect(url).toMatch(/^b4m-media:\/\/media\/profile-photo\//);
  });

  it('refuses a login page rather than writing it to disk as a picture', async () => {
    const html = Buffer.from('<html>sign in</html>', 'utf8');
    await expect(fetchProfilePhoto(await request(apiReturning(html, 'text/html')))).resolves.toBeNull();
  });

  it('refuses a response whose type is not one the media protocol can serve', async () => {
    await expect(fetchProfilePhoto(await request(apiReturning(PNG, 'image/tiff')))).resolves.toBeNull();
  });

  it('gives up quietly when the download fails', async () => {
    const api = {
      getAxiosInstance: () => ({ get: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }),
    } as unknown as AuthenticatedApiClient;

    await expect(fetchProfilePhoto(await request(api))).resolves.toBeNull();
  });

  it('rechecks the auth generation inside the queued cache store', async () => {
    const requestValue = await request(apiReturning(PNG, 'image/png'));
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await fetchProfilePhoto({ ...requestValue, isCurrent })).toBeNull();
    expect(isCurrent).toHaveBeenCalledTimes(2);
    expect(await requestValue.cache.lookup(profilePhotoCacheKey('user-1', KEY))).toBeNull();
  });

  it('writes nothing once the session it belongs to has ended', async () => {
    const request = {
      api: apiReturning(PNG, 'image/png'),
      cache: await cache(),
      logger: silentLogger,
      userId: 'user-1',
      source: KEY,
      cdnUrl: '/api/app-files/serve',
      isCurrent: () => false,
    };

    await expect(fetchProfilePhoto(request)).resolves.toBeNull();
    await expect(request.cache.lookup(profilePhotoCacheKey('user-1', KEY))).resolves.toBeNull();
  });

  it('does not download at all when the key cannot be placed', async () => {
    const get = vi.fn();
    const api = { getAxiosInstance: () => ({ get }) } as unknown as AuthenticatedApiClient;

    await expect(fetchProfilePhoto(await request(api, ''))).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});
