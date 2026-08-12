import { IScopedSettingsRepository, ScopeRef, SettingKey } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

interface ScopedCacheEntry {
  /** The override value, or null when we have confirmed there is NO override at this rung (negative cache). */
  value: string | null;
  timestamp: number;
  ttl: number;
}

/** Address of one cached override, shared by the cache and its callers so lookups are consistent. */
export function scopedOverrideKey(scopeLevel: string, scopeId: string, settingName: string): string {
  return JSON.stringify([scopeLevel, scopeId, settingName]);
}

function scopeKey(scopeLevel: string, scopeId: string): string {
  return JSON.stringify([scopeLevel, scopeId]);
}

/**
 * In-memory cache for scoped setting OVERRIDES, sibling to `AdminSettingsCache` (which caches the
 * flat platform table). Unlike the platform cache it cannot hold one "all settings" blob - overrides
 * are per (rung, setting) and can be many (a value per lake), so each address is cached individually
 * and negatively (a confirmed absence is cached too, so an un-overridden setting does not re-query
 * every resolve).
 *
 * Entries are nested one level per rung address so a whole rung invalidates in one delete (the shape
 * a future scoped-override writer needs). The cache key carries the scope rung, which is the whole
 * reason this is separate from `AdminSettingsCache`: that one keys by bare `settingName`, so scoped
 * values would collide there. See #1660.
 */
export class ScopedSettingsCache {
  private cache: Map<string, Map<string, ScopedCacheEntry>> = new Map();
  private logger: Logger;
  private maxScopes = 5000;

  private static readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes, matching AdminSettingsCache
  private static readonly DEVELOPMENT_TTL = 30 * 1000;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  private getTTL(): number {
    return process.env.NODE_ENV === 'development'
      ? ScopedSettingsCache.DEVELOPMENT_TTL
      : ScopedSettingsCache.DEFAULT_TTL;
  }

  private isValid(entry: ScopedCacheEntry): boolean {
    return Date.now() - entry.timestamp < entry.ttl;
  }

  /**
   * Resolve override values for the given rungs and setting names, reading through the cache. Returns
   * a map keyed by `scopedOverrideKey(level,id,name)` -> value|null for EVERY (scope, name) pair
   * requested, so the resolver can look up any rung deterministically. One DB query covers all misses.
   */
  async getOverrides(
    scopes: ScopeRef[],
    settingNames: SettingKey[],
    db: { scopedSettings: Pick<IScopedSettingsRepository, 'findOverrides'> }
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (scopes.length === 0 || settingNames.length === 0) return out;

    const missingScopeRefs = new Map<string, ScopeRef>();
    const missingNames = new Set<SettingKey>();

    for (const scope of scopes) {
      const inner = this.cache.get(scopeKey(scope.scopeLevel, scope.scopeId));
      for (const name of settingNames) {
        const outKey = scopedOverrideKey(scope.scopeLevel, scope.scopeId, name);
        const cached = inner?.get(name);
        if (cached && this.isValid(cached)) {
          out.set(outKey, cached.value);
        } else {
          if (cached) inner!.delete(name);
          out.set(outKey, null); // provisional; overwritten below if the DB has a row
          missingScopeRefs.set(scopeKey(scope.scopeLevel, scope.scopeId), scope);
          missingNames.add(name);
        }
      }
    }

    if (missingScopeRefs.size === 0) return out;

    const rows = await db.scopedSettings.findOverrides(Array.from(missingScopeRefs.values()), Array.from(missingNames));
    const ttl = this.getTTL();
    const now = Date.now();

    const found = new Set<string>();
    for (const row of rows) {
      out.set(scopedOverrideKey(row.scopeLevel, row.scopeId, row.settingName), row.settingValue);
      this.put(row.scopeLevel, row.scopeId, row.settingName, row.settingValue, now, ttl);
      found.add(scopedOverrideKey(row.scopeLevel, row.scopeId, row.settingName));
    }
    // Cache the confirmed absences too, so an un-overridden rung is not re-queried every resolve.
    for (const scope of missingScopeRefs.values()) {
      for (const name of missingNames) {
        if (!found.has(scopedOverrideKey(scope.scopeLevel, scope.scopeId, name))) {
          this.put(scope.scopeLevel, scope.scopeId, name, null, now, ttl);
        }
      }
    }

    if (this.cache.size > this.maxScopes) this.evictOldestScopes();
    return out;
  }

  private put(scopeLevel: string, scopeId: string, name: string, value: string | null, now: number, ttl: number): void {
    const sk = scopeKey(scopeLevel, scopeId);
    let inner = this.cache.get(sk);
    if (!inner) {
      inner = new Map();
      this.cache.set(sk, inner);
    }
    inner.set(name, { value, timestamp: now, ttl });
  }

  private evictOldestScopes(): void {
    // Evict whole rungs by their most-recently-written entry, oldest first.
    const freshness = (inner: Map<string, ScopedCacheEntry>) =>
      Math.max(...Array.from(inner.values()).map(e => e.timestamp));
    const scopesByAge = Array.from(this.cache.entries()).sort((a, b) => freshness(a[1]) - freshness(b[1]));
    const toRemove = this.cache.size - this.maxScopes;
    for (let i = 0; i < toRemove; i++) this.cache.delete(scopesByAge[i][0]);
    this.logger.warn(`ScopedSettingsCache evicted ${toRemove} oldest rungs (size limit)`);
  }

  /** Invalidate every cached value for one rung address (call this from a future scoped-override writer). */
  invalidateScope(scopeLevel: string, scopeId: string): void {
    this.cache.delete(scopeKey(scopeLevel, scopeId));
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}
