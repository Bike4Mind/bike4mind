import { Logger } from '@bike4mind/observability';
import { LlmTools } from './index';

/**
 * Tool availability cache entry
 */
interface ToolCacheEntry {
  available: boolean;
  lastChecked: number;
  failureCount: number;
  lastError?: string;
}

/**
 * Tool cache configuration
 */
interface ToolCacheConfig {
  ttl: number; // Time-to-live in milliseconds
  maxFailures: number; // Max failures before marking tool as unavailable
}

const DEFAULT_CONFIG: ToolCacheConfig = {
  ttl: 5 * 60 * 1000, // 5 minutes
  maxFailures: 3,
};

/**
 * Manages tool availability cache per session to prevent redundant checks
 * and provide fast tool state validation
 */
export class ToolCacheManager {
  private cache: Map<string, Map<LlmTools, ToolCacheEntry>>;
  private config: ToolCacheConfig;
  private logger: Logger;

  constructor(logger: Logger, config: Partial<ToolCacheConfig> = {}) {
    this.cache = new Map();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;
  }

  /**
   * Get cache key for a session and tool combination
   */
  private getCacheKey(sessionId: string): string {
    return `session:${sessionId}`;
  }

  /**
   * Initialize cache for a session with default tool availability
   */
  initializeSession(sessionId: string, availableTools: LlmTools[]): void {
    const cacheKey = this.getCacheKey(sessionId);
    if (!this.cache.has(cacheKey)) {
      const sessionCache = new Map<LlmTools, ToolCacheEntry>();
      availableTools.forEach(tool => {
        sessionCache.set(tool, {
          available: true,
          lastChecked: Date.now(),
          failureCount: 0,
        });
      });
      this.cache.set(cacheKey, sessionCache);
      this.logger.info(`📦 [ToolCache] Initialized cache for session ${sessionId} with ${availableTools.length} tools`);
    }
  }

  /**
   * Check if a tool is available and cache is valid
   */
  isToolAvailable(sessionId: string, tool: LlmTools): boolean {
    const cacheKey = this.getCacheKey(sessionId);
    const sessionCache = this.cache.get(cacheKey);

    if (!sessionCache) {
      this.logger.warn(`📦 [ToolCache] No cache found for session ${sessionId}`);
      return true; // Assume available if no cache
    }

    const entry = sessionCache.get(tool);
    if (!entry) {
      this.logger.warn(`📦 [ToolCache] No cache entry for tool ${tool} in session ${sessionId}`);
      return true; // Assume available if no entry
    }

    // Check if cache is expired
    const isExpired = Date.now() - entry.lastChecked > this.config.ttl;
    if (isExpired) {
      this.logger.debug(`📦 [ToolCache] Cache expired for tool ${tool} in session ${sessionId}`);
      return true; // Recheck if expired
    }

    // Check if tool has too many failures
    if (entry.failureCount >= this.config.maxFailures) {
      this.logger.warn(
        `📦 [ToolCache] Tool ${tool} marked unavailable due to ${entry.failureCount} failures in session ${sessionId}`
      );
      return false;
    }

    return entry.available;
  }

  /**
   * Mark a tool as successful after execution
   */
  markToolSuccess(sessionId: string, tool: LlmTools): void {
    const cacheKey = this.getCacheKey(sessionId);
    const sessionCache = this.cache.get(cacheKey);

    if (!sessionCache) {
      return;
    }

    const entry = sessionCache.get(tool);
    if (entry) {
      entry.available = true;
      entry.lastChecked = Date.now();
      entry.failureCount = 0; // Reset failure count on success
      entry.lastError = undefined;
      this.logger.debug(`📦 [ToolCache] Marked tool ${tool} as successful in session ${sessionId}`);
    }
  }

  /**
   * Mark a tool as failed and increment failure count
   */
  markToolFailure(sessionId: string, tool: LlmTools, error: string): void {
    const cacheKey = this.getCacheKey(sessionId);
    const sessionCache = this.cache.get(cacheKey);

    if (!sessionCache) {
      return;
    }

    let entry = sessionCache.get(tool);
    if (!entry) {
      // Create entry if it doesn't exist
      entry = {
        available: true,
        lastChecked: Date.now(),
        failureCount: 0,
      };
      sessionCache.set(tool, entry);
    }

    entry.failureCount++;
    entry.lastChecked = Date.now();
    entry.lastError = error;
    entry.available = entry.failureCount < this.config.maxFailures;

    this.logger.warn(
      `📦 [ToolCache] Tool ${tool} failed (${entry.failureCount}/${this.config.maxFailures}) in session ${sessionId}: ${error}`
    );
  }

  /**
   * Get tool state for debugging
   */
  getToolState(sessionId: string, tool: LlmTools): ToolCacheEntry | null {
    const cacheKey = this.getCacheKey(sessionId);
    const sessionCache = this.cache.get(cacheKey);
    return sessionCache?.get(tool) || null;
  }

  /**
   * Get all tool states for a session
   */
  getSessionToolStates(sessionId: string): Map<LlmTools, ToolCacheEntry> | null {
    const cacheKey = this.getCacheKey(sessionId);
    return this.cache.get(cacheKey) || null;
  }

  /**
   * Clear cache for a session
   */
  clearSession(sessionId: string): void {
    const cacheKey = this.getCacheKey(sessionId);
    this.cache.delete(cacheKey);
    this.logger.info(`📦 [ToolCache] Cleared cache for session ${sessionId}`);
  }

  /**
   * Clear all caches (useful for testing or cleanup)
   */
  clearAll(): void {
    this.cache.clear();
    this.logger.info('📦 [ToolCache] Cleared all tool caches');
  }

  /**
   * Perform cache maintenance - remove expired entries
   */
  performMaintenance(): void {
    const now = Date.now();
    let removedCount = 0;

    for (const [sessionKey, sessionCache] of this.cache.entries()) {
      for (const [tool, entry] of sessionCache.entries()) {
        const isExpired = now - entry.lastChecked > this.config.ttl * 2; // Double TTL for cleanup
        if (isExpired) {
          sessionCache.delete(tool);
          removedCount++;
        }
      }

      // Remove empty session caches
      if (sessionCache.size === 0) {
        this.cache.delete(sessionKey);
      }
    }

    if (removedCount > 0) {
      this.logger.info(`📦 [ToolCache] Maintenance: Removed ${removedCount} expired tool cache entries`);
    }
  }
}
