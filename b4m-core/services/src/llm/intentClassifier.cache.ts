import { createHash } from 'crypto';

/**
 * In-memory LRU cache for intent classifier decisions.
 *
 * Keyed by `sha256(userId :: normalize(message) :: contextFlags)` so two
 * users sending the same message don't collide AND so the same message with
 * different prompt-context flags (file attachments, agent mentions) gets a
 * distinct slot - those flags change the prompt and therefore the decision.
 *
 * 1h TTL. Bounded LRU eviction - without a ceiling, a busy lambda warm pool
 * would grow unbounded across thousands of classifications per warm window.
 */

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 1000;

export interface CacheKeyParts {
  userId: string;
  message: string;
  /**
   * Prompt-context flags that affect the classifier's input and therefore
   * its output. Must participate in the cache key - otherwise the same
   * message with vs. without an attachment collides on a stale decision.
   */
  hasFileAttachments?: boolean;
  hasAgentMention?: boolean;
}

export function normalizeMessage(message: string): string {
  // Collapse whitespace and lowercase so trivial reformattings hit the cache.
  // Keep punctuation - "what's the weather" vs "what's the weather!" can
  // legitimately differ in tone but rarely in routing, so this is good enough.
  return message.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function hashCacheKey(key: CacheKeyParts): string {
  const f = key.hasFileAttachments ? 1 : 0;
  const a = key.hasAgentMention ? 1 : 0;
  const namespaced = `${key.userId}::${normalizeMessage(key.message)}::f${f}::a${a}`;
  return createHash('sha256').update(namespaced).digest('hex');
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export interface IntentClassifierCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export class IntentClassifierCache<V = unknown> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IntentClassifierCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  get(parts: CacheKeyParts): V | undefined {
    const key = hashCacheKey(parts);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    // LRU refresh: re-insert moves the key to the end of Map insertion order.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(parts: CacheKeyParts, value: V): void {
    const key = hashCacheKey(parts);
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

let sharedCache: IntentClassifierCache | null = null;

/**
 * Lambda-warm singleton. A fresh instance per warm container is the right
 * granularity - across containers we accept duplicate work in exchange for
 * zero coordination.
 */
export function getSharedIntentCache<V = unknown>(): IntentClassifierCache<V> {
  if (!sharedCache) sharedCache = new IntentClassifierCache();
  return sharedCache as IntentClassifierCache<V>;
}
