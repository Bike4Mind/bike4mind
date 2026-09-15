import { Logger } from '@bike4mind/observability';

interface RapidReplyMappingCacheEntry {
  data: any; // RapidReplyMapping type
  timestamp: number;
  ttl: number;
}

/**
 * In-memory cache for rapid reply mappings with TTL support
 * Follows AdminSettingsCache pattern for consistency
 */
export class RapidReplyMappingsCache {
  private cache: Map<string, RapidReplyMappingCacheEntry> = new Map();
  private logger: Logger;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private maxCacheSize: number = 200; // Reasonable limit for model mappings

  // Rapid reply mappings change very rarely
  private static readonly DEFAULT_TTL = 15 * 60 * 1000; // 15 minutes
  private static readonly DEVELOPMENT_TTL = 60 * 1000; // 1 minute in development
  private static readonly CLEANUP_INTERVAL = 60 * 1000; // Clean up every minute

  constructor(logger: Logger) {
    this.logger = logger;
    this.startCleanupTimer();
  }

  /**
   * Start periodic cleanup timer (only in persistent environments)
   */
  private startCleanupTimer(): void {
    // Only start cleanup in persistent environments (not serverless)
    if (process.env.NODE_ENV !== 'production' || process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
      this.logger.debug('Skipping rapid reply mappings cache cleanup timer in serverless environment');
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.performCleanup();
    }, RapidReplyMappingsCache.CLEANUP_INTERVAL);

    this.logger.debug('Started rapid reply mappings cache cleanup timer');
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  public stopCleanupTimer(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
      this.logger.debug('Stopped rapid reply mappings cache cleanup timer');
    }
  }

  /**
   * Active cleanup of expired entries
   */
  private performCleanup(): void {
    const beforeSize = this.cache.size;
    let removedCount = 0;

    // Clean up expired entries
    for (const [key, entry] of Array.from(this.cache.entries())) {
      if (!this.isValid(entry.timestamp, entry.ttl)) {
        this.cache.delete(key);
        removedCount++;
      }
    }

    // Emergency cleanup if cache is too large
    if (this.cache.size > this.maxCacheSize) {
      const entries = Array.from(this.cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp); // Remove oldest first
      const toRemove = this.cache.size - this.maxCacheSize;

      for (let i = 0; i < toRemove; i++) {
        this.cache.delete(entries[i][0]);
        removedCount++;
      }

      this.logger.warn(`Emergency rapid reply mappings cache cleanup: removed ${toRemove} entries due to size limit`);
    }

    if (removedCount > 0) {
      this.logger.debug(
        `Rapid reply mappings cache cleanup removed ${removedCount} expired entries (${beforeSize} → ${this.cache.size})`
      );
    }
  }

  /**
   * Get TTL based on environment
   */
  private getTTL(): number {
    return process.env.NODE_ENV === 'development'
      ? RapidReplyMappingsCache.DEVELOPMENT_TTL
      : RapidReplyMappingsCache.DEFAULT_TTL;
  }

  /**
   * Check if cache entry is valid (not expired)
   */
  private isValid(timestamp: number, ttl: number): boolean {
    return Date.now() - timestamp < ttl;
  }

  /**
   * Get rapid reply mapping for a model with caching
   */
  async getRapidReplyMapping(primaryModel: string, db: any): Promise<any> {
    const cacheKey = `rapidmapping:${primaryModel}`;
    const cached = this.cache.get(cacheKey);

    // Return cached data if valid
    if (cached && this.isValid(cached.timestamp, cached.ttl)) {
      this.logger.debug(`📦 Rapid reply mapping cache HIT for model ${primaryModel}`);
      return cached.data;
    }

    // Remove expired entry
    if (cached) {
      this.cache.delete(cacheKey);
    }

    // Cache miss - fetch from database
    this.logger.debug(`🔍 Rapid reply mapping cache MISS for model ${primaryModel} - fetching from database`);
    const fetchStart = Date.now();

    const rapidReplyMapping = await db.rapidReply.mappings.findByMainModel(primaryModel);

    const fetchTime = Date.now() - fetchStart;
    this.logger.info(`📦 Cached rapid reply mapping for model ${primaryModel} in ${fetchTime}ms`);

    // Store in cache
    const ttl = this.getTTL();
    this.cache.set(cacheKey, {
      data: rapidReplyMapping,
      timestamp: Date.now(),
      ttl,
    });

    return rapidReplyMapping;
  }

  /**
   * Invalidate mapping for specific model
   */
  invalidateModel(primaryModel: string): void {
    const cacheKey = `rapidmapping:${primaryModel}`;
    this.cache.delete(cacheKey);
    this.logger.info(`🗑️ Invalidated rapid reply mapping cache for model: ${primaryModel}`);
  }

  /**
   * Invalidate all cached mappings
   */
  invalidateAll(): void {
    this.cache.clear();
    this.logger.info('🗑️ Invalidated all rapid reply mappings cache');
  }

  /**
   * Get cache statistics for monitoring
   */
  getStats(): {
    totalEntries: number;
    memoryUsage: {
      approximate: string;
      cacheSize: number;
    };
    environment: {
      isServerless: boolean;
      hasCleanupTimer: boolean;
    };
  } {
    const estimateMemoryUsage = () => {
      let totalSize = 0;
      for (const [key] of Array.from(this.cache.entries())) {
        totalSize += key.length * 2; // UTF-16 characters
        totalSize += 512; // Estimate for mapping object
      }
      return totalSize;
    };

    return {
      totalEntries: this.cache.size,
      memoryUsage: {
        approximate: `~${Math.round(estimateMemoryUsage() / 1024)}KB`,
        cacheSize: this.cache.size,
      },
      environment: {
        isServerless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
        hasCleanupTimer: this.cleanupInterval !== null,
      },
    };
  }

  /**
   * Graceful shutdown - cleanup timers
   */
  public shutdown(): void {
    this.stopCleanupTimer();
    this.logger.info('🛑 Rapid reply mappings cache shutdown complete');
  }
}
