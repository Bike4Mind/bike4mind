import { IAdminSettingsRepository, IAdminSettings } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

/**
 * A structural subset of `Logger` with every method optional, matching how this file actually
 * calls it (`this.logger.debug?.()`, see the comment on `logger` below) rather than the promise
 * `Logger` itself makes (all three required). A full `Logger` still satisfies this - it is a
 * superset - so every real construction site is unaffected; this only stops the FIELD from
 * claiming a guarantee the class deliberately does not rely on.
 */
export interface PartialAdminSettingsLogger {
  debug?: Logger['debug'];
  info?: Logger['info'];
  warn?: Logger['warn'];
}

interface CacheEntry {
  data: Record<string, string>;
  timestamp: number;
  ttl: number;
}

interface IndividualSettingCache {
  value: string | null;
  timestamp: number;
  ttl: number;
}

/**
 * In-memory cache for admin settings with TTL support and active cleanup
 * Can be easily extended to use Redis for production
 */
export class AdminSettingsCache {
  private cache: Map<string, CacheEntry> = new Map();
  private individualCache: Map<string, IndividualSettingCache> = new Map();
  /**
   * Every call through this field is optional-chained (`this.logger.debug?.()`).
   *
   * A cache must not throw because it could not log, and this one is exposed to that: it is a
   * process-wide singleton created with whichever logger happens to reach `getSettingsCache` first.
   * What each caller then does with a throw varies, and it is mostly NOT a degrade-to-defaults
   * guard: `getSettingsByNames` has none at all, the scoped resolver guards one layer out in
   * `resolveAll`, and `resolveSpendLevers` deliberately rethrows to halt spend. So a logger missing
   * a quieter level could surface as a silent wrong VALUE, as an unhandled rejection, or as a hard
   * fail-closed, depending on who asked. `ScopedSettingsCache` is built by the same factory pair
   * and still has one unguarded call - the same hazard, not a solved one.
   */
  private logger: PartialAdminSettingsLogger;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private maxCacheSize: number = 1000; // Prevent memory leaks

  // Cache settings - admin settings change very rarely
  private static readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes
  private static readonly DEVELOPMENT_TTL = 30 * 1000; // 30 seconds in development
  private static readonly CLEANUP_INTERVAL = 60 * 1000; // Clean up every minute

  // Widened to match the field: a full `Logger` is a superset, so every existing construction site
  // is unaffected. Note `getSettingsCache`/`getSettingsByNames` above still narrow to `Logger`, so
  // a partial logger cannot yet reach here through them.
  constructor(logger: PartialAdminSettingsLogger) {
    this.logger = logger;
    this.startCleanupTimer();
  }

  /**
   * Start periodic cleanup timer (only in persistent environments)
   */
  private startCleanupTimer(): void {
    // Only start cleanup in persistent environments (not serverless)
    if (process.env.NODE_ENV !== 'production' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      this.logger.debug?.('Skipping cleanup timer in serverless environment');
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, AdminSettingsCache.CLEANUP_INTERVAL);

    this.logger.debug?.('Started cache cleanup timer');
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  public stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      this.logger.debug?.('Stopped cache cleanup timer');
    }
  }

  /**
   * Active cleanup of expired entries
   */
  private performCleanup(): void {
    const beforeSize = this.cache.size + this.individualCache.size;
    let removedCount = 0;

    // Clean up main cache - convert to array to avoid iterator type issues
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (!this.isValid(entry.timestamp, entry.ttl)) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    // Clean up individual cache - convert to array to avoid iterator type issues
    for (const [key, entry] of Array.from(this.individualCache.entries())) {
      if (!this.isValid(entry.timestamp, entry.ttl)) {
        this.individualCache.delete(key);
        removedCount++;
      }
    }

    // Emergency cleanup if cache is too large
    if (this.individualCache.size > this.maxCacheSize) {
      const entries = Array.from(this.individualCache.entries());
      // Remove oldest entries first
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = this.individualCache.size - this.maxCacheSize;

      for (let i = 0; i < toRemove; i++) {
        this.individualCache.delete(entries[i][0]);
        removedCount++;
      }

      this.logger.warn?.(`Emergency cache cleanup: removed ${toRemove} entries due to size limit`);
    }

    if (removedCount > 0) {
      this.logger.debug?.(
        `Cache cleanup removed ${removedCount} expired entries (${beforeSize} → ${this.cache.size + this.individualCache.size})`
      );
    }
  }

  /**
   * Get TTL based on environment
   */
  private getTTL(): number {
    return process.env.NODE_ENV === 'development' ? AdminSettingsCache.DEVELOPMENT_TTL : AdminSettingsCache.DEFAULT_TTL;
  }

  /**
   * Check if cache entry is valid (not expired)
   */
  private isValid(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp < ttl;
  }

  /**
   * Get all admin settings with caching
   */
  async getSettingsMap(db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findAll'>;
  }): Promise<Record<string, string>> {
    const cacheKey = 'all_settings';
    const cached = this.cache.get(cacheKey);

    // Return cached data if valid
    if (cached && this.isValid(cached.timestamp, cached.ttl)) {
      this.logger.debug?.('📦 Admin settings cache HIT');
      return cached.data;
    }

    // Remove expired entry
    if (cached) {
      this.cache.delete(cacheKey);
    }

    // Cache miss - fetch from database
    this.logger.debug?.('🔍 Admin settings cache MISS - fetching from database');
    const fetchStart = Date.now();

    const settings = await db.adminSettings.findAll();
    const settingsMap = settings.reduce(
      (out: Record<string, string>, s: any) => {
        out[s.settingName] = s.settingValue;
        return out;
      },
      {} as Record<string, string>
    );

    const fetchTime = Date.now() - fetchStart;
    this.logger.info?.(`📦 Cached ${Object.keys(settingsMap).length} admin settings in ${fetchTime}ms`);

    // Store in cache
    const ttl = this.getTTL();
    this.cache.set(cacheKey, {
      data: settingsMap,
      timestamp: Date.now(),
      ttl,
    });

    // Also cache individual settings for faster individual lookups
    Object.entries(settingsMap).forEach(([key, value]) => {
      this.individualCache.set(key, {
        value: value as string | null,
        timestamp: Date.now(),
        ttl,
      });
    });

    return settingsMap;
  }

  /**
   * Get individual admin setting with caching
   */
  async getSettingByName(
    settingName: IAdminSettings['settingName'],
    db: {
      adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>;
    }
  ): Promise<string | null> {
    const cached = this.individualCache.get(settingName);

    // Return cached data if valid
    if (cached && this.isValid(cached.timestamp, cached.ttl)) {
      this.logger.debug?.(`📦 Individual setting '${settingName}' cache HIT`);
      return cached.value;
    }

    // Remove expired entry
    if (cached) {
      this.individualCache.delete(settingName);
    }

    // Cache miss - fetch from database
    this.logger.debug?.(`🔍 Individual setting '${settingName}' cache MISS - fetching from database`);
    const fetchStart = Date.now();

    const setting = await db.adminSettings.findBySettingName(settingName);
    // `?? null`, not `|| null`: a setting stored as boolean `false` (e.g. an admin-disabled
    // defaultValue:true flag) must survive the round-trip. `|| null` collapsed it to null,
    // which let the caller fall back to the default and silently re-enable the flag.
    const value = setting?.settingValue ?? null;

    const fetchTime = Date.now() - fetchStart;
    this.logger.debug?.(`📦 Cached individual setting '${settingName}' in ${fetchTime}ms`);

    // Store in cache
    this.individualCache.set(settingName, {
      value,
      timestamp: Date.now(),
      ttl: this.getTTL(),
    });

    return value;
  }

  /**
   * Get multiple admin settings with caching
   */
  async getSettingsByNames(
    settingNames: IAdminSettings['settingName'][],
    db: {
      adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames'>;
    }
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const uncachedSettings: IAdminSettings['settingName'][] = [];

    // Check cache for each setting
    for (const settingName of settingNames) {
      const cached = this.individualCache.get(settingName);
      if (cached && this.isValid(cached.timestamp, cached.ttl)) {
        if (cached.value !== null) {
          result[settingName] = cached.value;
        }
      } else {
        // Remove expired entry
        if (cached) {
          this.individualCache.delete(settingName);
        }
        uncachedSettings.push(settingName);
      }
    }

    // Fetch uncached settings from database
    if (uncachedSettings.length > 0) {
      this.logger.debug?.(
        `🔍 Batch fetching ${uncachedSettings.length} uncached settings: ${uncachedSettings.join(', ')}`
      );
      const fetchStart = Date.now();

      const settings = await db.adminSettings.findBySettingNames(uncachedSettings);
      const fetchTime = Date.now() - fetchStart;

      this.logger.debug?.(`📦 Batch fetched ${settings.length} settings in ${fetchTime}ms`);

      // Cache and add to result
      const ttl = this.getTTL();
      settings.forEach((setting: any) => {
        result[setting.settingName] = setting.settingValue;
        this.individualCache.set(setting.settingName, {
          value: setting.settingValue,
          timestamp: Date.now(),
          ttl,
        });
      });

      // Cache null values for settings that weren't found
      uncachedSettings.forEach(settingName => {
        if (!settings.some((s: any) => s.settingName === settingName)) {
          this.individualCache.set(settingName, {
            value: null,
            timestamp: Date.now(),
            ttl,
          });
        }
      });
    }

    this.logger.debug?.(
      `📦 Returned ${Object.keys(result).length} settings (${settingNames.length - uncachedSettings.length} from cache, ${uncachedSettings.length} from DB)`
    );
    return result;
  }

  /**
   * Invalidate specific setting(s) from cache
   */
  invalidateSetting(settingName: string): void {
    this.individualCache.delete(settingName);
    this.cache.delete('all_settings'); // Invalidate full cache too
    this.logger.info?.(`🗑️ Invalidated cache for setting: ${settingName}`);
  }

  /**
   * Invalidate all cached admin settings
   */
  invalidateAll(): void {
    this.cache.clear();
    this.individualCache.clear();
    this.logger.info?.('🗑️ Invalidated all admin settings cache');
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    totalEntries: number;
    individualEntries: number;
    memoryUsage: {
      approximate: string;
      cacheSize: number;
      individualCacheSize: number;
    };
    environment: {
      isServerless: boolean;
      hasCleanupTimer: boolean;
    };
  } {
    // More accurate memory calculation
    const estimateMemoryUsage = () => {
      let totalSize = 0;
      for (const [key, value] of Array.from(this.individualCache.entries())) {
        totalSize += key.length * 2; // UTF-16 characters
        totalSize += (value.value?.length || 0) * 2;
        totalSize += 32; // Object overhead
      }
      return totalSize;
    };

    return {
      totalEntries: this.cache.size,
      individualEntries: this.individualCache.size,
      memoryUsage: {
        approximate: `~${Math.round(estimateMemoryUsage() / 1024)}KB`,
        cacheSize: this.cache.size,
        individualCacheSize: this.individualCache.size,
      },
      environment: {
        isServerless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
        hasCleanupTimer: this.cleanupInterval !== null,
      },
    };
  }

  /**
   * Warm up the cache by fetching all settings
   */
  async warmUp(db: any): Promise<void> {
    this.logger.info?.('🔥 Warming up admin settings cache...');
    await this.getSettingsMap(db);
    this.logger.info?.('✅ Admin settings cache warmed up');
  }

  /**
   * Graceful shutdown - cleanup timers
   */
  public shutdown(): void {
    this.stopCleanupTimer();
    this.logger.info?.('🛑 Admin settings cache shutdown complete');
  }
}
