import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationCache, MemoryApplicationCache, RedisHttpApplicationCache } from './ApplicationCache';

afterEach(() => vi.unstubAllGlobals());

describe('application cache configuration', () => {
  it('defaults to memory without fetching or requiring Redis configuration', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const cache = createApplicationCache('test', {});
    expect(cache).toBeInstanceOf(MemoryApplicationCache);
    const load = vi.fn().mockResolvedValue(null);
    expect(await cache.getOrLoad('key', 1000, load)).toBeNull();
    expect(await cache.getOrLoad('key', 1000, load)).toBeNull();
    expect(load).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown backends and incomplete Redis configuration', () => {
    expect(() => createApplicationCache('test', { B4M_CACHE_BACKEND: 'unknown' })).toThrow('Unsupported');
    expect(() => createApplicationCache('test', { B4M_CACHE_BACKEND: 'redis-http' })).toThrow('requires');
    expect(() => new RedisHttpApplicationCache({ url: 'redis://localhost', token: 'test', prefix: 'test' })).toThrow();
  });

  it('selects Redis and scopes keys by deployment and namespace', async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ result: 'OK' }));
    vi.stubGlobal('fetch', fetch);
    const env = {
      B4M_CACHE_BACKEND: 'redis-http',
      B4M_CACHE_REDIS_HTTP_URL: 'https://cache.example',
      B4M_CACHE_REDIS_HTTP_TOKEN: 'test',
      B4M_CACHE_PREFIX: 'deployment',
    };
    const cache = createApplicationCache('breaker', env);
    expect(cache).toBeInstanceOf(RedisHttpApplicationCache);
    await cache.invalidate();
    expect(JSON.parse(fetch.mock.calls[0][1].body)[1]).toBe('b4m:{deployment:breaker}:v1:revision');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test');
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('memory application cache', () => {
  it('expires entries and bounds memory', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const cache = new MemoryApplicationCache(1);
    const load = vi.fn().mockResolvedValue('value');
    await cache.getOrLoad('a', 100, load);
    await cache.getOrLoad('b', 100, load);
    await cache.getOrLoad('a', 100, load);
    expect(load).toHaveBeenCalledTimes(3);
    vi.mocked(Date.now).mockReturnValue(101);
    await cache.getOrLoad('a', 100, load);
    expect(load).toHaveBeenCalledTimes(4);
    vi.restoreAllMocks();
  });

  it('does not publish an in-flight load after invalidation', async () => {
    const cache = new MemoryApplicationCache();
    let resolve!: (value: string) => void;
    const pending = cache.getOrLoad(
      'key',
      1000,
      () =>
        new Promise<string>(done => {
          resolve = done;
        })
    );
    await cache.invalidate();
    resolve('old');
    expect(await pending).toBe('old');
    expect(await cache.getOrLoad('key', 1000, async () => 'new')).toBe('new');
  });
});

describe('Redis HTTP failure semantics', () => {
  const options = { url: 'https://cache.example', token: 'test', prefix: 'test' };

  it.each([
    new Error('network failure'),
    new DOMException('timed out', 'TimeoutError'),
    new Response('unavailable', { status: 503 }),
    Response.json({ error: 'command failed' }),
    Response.json({ result: ['0', '{bad json'] }),
  ])('loads the source on read failure (%s)', async response => {
    const fetch = vi.fn();
    if (response instanceof Error || response instanceof DOMException) fetch.mockRejectedValue(response);
    else fetch.mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const onError = vi.fn();
    const cache = new RedisHttpApplicationCache({ ...options, onError });
    expect(await cache.getOrLoad('key', 1000, async () => 'fresh')).toBe('fresh');
    expect(onError).toHaveBeenCalledWith('read', expect.anything());
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns fresh data when the write fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ result: ['0', null] }))
        .mockRejectedValueOnce(new Error('write failed'))
    );
    const onError = vi.fn();
    const cache = new RedisHttpApplicationCache({ ...options, onError });
    expect(await cache.getOrLoad('key', 1000, async () => 'fresh')).toBe('fresh');
    expect(onError).toHaveBeenCalledWith('write', expect.anything());
  });

  it('propagates loader errors without attempting a write', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ result: ['0', null] }));
    vi.stubGlobal('fetch', fetch);
    const cache = new RedisHttpApplicationCache(options);
    await expect(
      cache.getOrLoad('key', 1000, async () => {
        throw new Error('database failed');
      })
    ).rejects.toThrow('database failed');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('propagates invalidation failure instead of acknowledging it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(new RedisHttpApplicationCache(options).invalidate()).rejects.toThrow('offline');
  });

  it('requires an invalidation acknowledgement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ result: null })));
    await expect(new RedisHttpApplicationCache(options).invalidate()).rejects.toThrow('not acknowledged');
  });
});

describe.skipIf(!process.env.B4M_TEST_REDIS_HTTP_URL)('real Redis shared cache', () => {
  function pair() {
    const options = {
      url: process.env.B4M_TEST_REDIS_HTTP_URL!,
      token: process.env.B4M_TEST_REDIS_HTTP_TOKEN || 'test',
      prefix: `test:{${crypto.randomUUID()}}`,
    };
    return [new RedisHttpApplicationCache(options), new RedisHttpApplicationCache(options)];
  }

  it('shares values and one invalidation between independent instances', async () => {
    const [first, second] = pair();
    const load = vi.fn().mockResolvedValue('old');
    expect(await first.getOrLoad('key', 1000, load)).toBe('old');
    expect(await second.getOrLoad('key', 1000, load)).toBe('old');
    expect(load).toHaveBeenCalledOnce();
    await first.invalidate();
    load.mockResolvedValue('new');
    expect(await second.getOrLoad('key', 1000, load)).toBe('new');
    expect(await first.getOrLoad('key', 1000, load)).toBe('new');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not repopulate an invalidated revision with a slow load', async () => {
    const [first, second] = pair();
    let resolve!: (value: string) => void;
    let started!: () => void;
    const loading = new Promise<void>(done => {
      started = done;
    });
    const pending = first.getOrLoad('key', 1000, () => {
      started();
      return new Promise<string>(done => {
        resolve = done;
      });
    });
    await loading;
    await second.invalidate();
    resolve('old');
    await pending;
    expect(await second.getOrLoad('key', 1000, async () => 'new')).toBe('new');
    expect(await first.getOrLoad('key', 1000, async () => 'unexpected')).toBe('new');
  });

  it('expires data and isolates namespaces', async () => {
    const [first] = pair();
    const [other] = pair();
    await first.getOrLoad('key', 1, async () => 'old');
    expect(await other.getOrLoad('key', 1000, async () => 'isolated')).toBe('isolated');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await first.getOrLoad('key', 1000, async () => 'fresh')).toBe('fresh');
  });
});
