import { randomUUID } from 'node:crypto';

export interface ApplicationCache {
  getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
  invalidate(): Promise<void>;
}

export class MemoryApplicationCache implements ApplicationCache {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private revision = 0;

  constructor(private readonly maxEntries = 200) {}

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const cached = this.entries.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    this.entries.delete(key);
    const revision = this.revision;
    const value = await load();
    if (revision === this.revision) {
      this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (this.entries.size > this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return value;
  }

  async invalidate(): Promise<void> {
    this.revision++;
    this.entries.clear();
  }
}

const READ = `
local revision = redis.call('GET', KEYS[1]) or '0'
local value = redis.call('GET', KEYS[2])
if value then
  local entry = cjson.decode(value)
  if entry.revision == revision then return {revision, entry.value} end
end
return {revision, false}`;

const WRITE = `
if (redis.call('GET', KEYS[1]) or '0') ~= ARGV[1] then return 0 end
redis.call('PSETEX', KEYS[2], ARGV[3], cjson.encode({revision=ARGV[1], value=ARGV[2]}))
return 1`;

export interface RedisHttpCacheOptions {
  url: string;
  token: string;
  prefix: string;
  timeoutMs?: number;
  onError?: (operation: 'read' | 'write', error: unknown) => void;
}

/** Redis command-over-HTTP API (for example Upstash or a self-hosted compatible gateway). */
export class RedisHttpApplicationCache implements ApplicationCache {
  constructor(private readonly options: RedisHttpCacheOptions) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !options.token) {
      throw new Error('Shared cache requires an HTTP(S) URL and bearer token');
    }
  }

  private async command(args: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.options.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 1000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Shared cache HTTP status ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('result' in body) || ('error' in body && body.error)) {
      throw new Error('Invalid shared cache command response');
    }
    return body.result;
  }

  private get revisionKey(): string {
    return `${this.options.prefix}:revision`;
  }

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const dataKey = `${this.options.prefix}:data:${encodeURIComponent(key)}`;
    let revision: string;
    try {
      const result = await this.command(['EVAL', READ, 2, this.revisionKey, dataKey]);
      if (!Array.isArray(result) || typeof result[0] !== 'string') {
        throw new Error('Invalid shared cache read response');
      }
      revision = result[0];
      if (typeof result[1] === 'string') return JSON.parse(result[1]) as T;
    } catch (error) {
      this.options.onError?.('read', error);
      return load();
    }

    const value = await load();
    try {
      // Compare and publish atomically so a pre-invalidation load cannot repopulate the cache.
      await this.command(['EVAL', WRITE, 2, this.revisionKey, dataKey, revision, JSON.stringify(value), ttlMs]);
    } catch (error) {
      this.options.onError?.('write', error);
    }
    return value;
  }

  async invalidate(): Promise<void> {
    const result = await this.command(['SET', this.revisionKey, randomUUID()]);
    if (result !== 'OK') throw new Error('Shared cache invalidation was not acknowledged');
  }
}

export function createApplicationCache(
  namespace: string,
  env: NodeJS.ProcessEnv = process.env,
  onError?: RedisHttpCacheOptions['onError']
): ApplicationCache {
  const backend = env.B4M_CACHE_BACKEND || 'memory';
  if (backend === 'memory') return new MemoryApplicationCache();
  if (backend !== 'redis-http') throw new Error('Unsupported B4M_CACHE_BACKEND');
  if (!env.B4M_CACHE_REDIS_HTTP_URL || !env.B4M_CACHE_REDIS_HTTP_TOKEN || !env.B4M_CACHE_PREFIX) {
    throw new Error(
      'redis-http cache requires B4M_CACHE_REDIS_HTTP_URL, B4M_CACHE_REDIS_HTTP_TOKEN and B4M_CACHE_PREFIX'
    );
  }
  return new RedisHttpApplicationCache({
    url: env.B4M_CACHE_REDIS_HTTP_URL,
    token: env.B4M_CACHE_REDIS_HTTP_TOKEN,
    prefix: `b4m:{${encodeURIComponent(env.B4M_CACHE_PREFIX)}:${encodeURIComponent(namespace)}}:v1`,
    onError,
  });
}
