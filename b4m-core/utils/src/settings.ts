import {
  IAdminSettings,
  IAdminSettingsRepository,
  IScopedSettingsRepository,
  ScopeRef,
  SettingKey,
  settingsMap,
} from '@bike4mind/common';
import { z } from 'zod';
import { AdminSettingsCache } from './cache/AdminSettingsCache';
import { ScopedSettingsCache } from './cache/ScopedSettingsCache';
import { Logger } from '@bike4mind/observability';

// Global cache instance - will be shared across all calls
let globalSettingsCache: AdminSettingsCache | null = null;
let globalScopedSettingsCache: ScopedSettingsCache | null = null;

/**
 * Get or create the global settings cache instance
 */
function getSettingsCache(logger?: Logger): AdminSettingsCache {
  if (!globalSettingsCache) {
    globalSettingsCache = new AdminSettingsCache(logger || new Logger());
  }
  return globalSettingsCache;
}

function getScopedSettingsCache(logger?: Logger): ScopedSettingsCache {
  if (!globalScopedSettingsCache) {
    globalScopedSettingsCache = new ScopedSettingsCache(logger || new Logger());
  }
  return globalScopedSettingsCache;
}

/**
 * Read org/owner/lake OVERRIDE values for a set of rungs and setting names, through the scoped cache.
 * Returns a map keyed by `scopedOverrideKey(level,id,name)` -> value|null (see ScopedSettingsCache).
 * Platform values are NOT here - the resolver layers these over the platform read. Passing no rungs
 * (a platform-altitude resolve) returns an empty map and touches neither cache nor DB.
 */
export async function getScopedOverrides(
  scopes: ScopeRef[],
  settingNames: SettingKey[],
  db: { scopedSettings: Pick<IScopedSettingsRepository, 'findOverrides'> },
  options?: { logger?: Logger }
): Promise<Map<string, string | null>> {
  return getScopedSettingsCache(options?.logger).getOverrides(scopes, settingNames, db);
}

/** Invalidate cached overrides for one rung address, or all of them. Call from a scoped-override writer. */
export function invalidateScopedSettingsCache(scope?: ScopeRef): void {
  if (!globalScopedSettingsCache) return;
  if (scope) {
    globalScopedSettingsCache.invalidateScope(scope.scopeLevel, scope.scopeId);
  } else {
    globalScopedSettingsCache.invalidateAll();
  }
}

// Function overload for when defaultValue is provided
export function getSettingsValue<K extends SettingKey>(
  key: K,
  settings: Record<string, string>,
  defaultValue: z.output<(typeof settingsMap)[K]['schema']>
): z.output<(typeof settingsMap)[K]['schema']>;

// Function overload for when defaultValue is not provided
export function getSettingsValue<K extends SettingKey>(
  key: K,
  settings: Record<string, string>
): z.output<(typeof settingsMap)[K]['schema']> | undefined;

// Implementation
export function getSettingsValue<K extends SettingKey>(
  key: K,
  settings: Record<string, string>,
  defaultValue?: z.output<(typeof settingsMap)[K]['schema']>
): z.output<(typeof settingsMap)[K]['schema']> | undefined {
  const settingConfig = settingsMap[key];
  if (!settingConfig) {
    // Log warning but don't break existing code
    Logger.globalInstance.warn(`Unknown setting key: ${key}`);
    return defaultValue;
  }

  const rawValue = settings[key];
  const parsed = settingConfig.schema.safeParse(rawValue);

  if (parsed.success) {
    // A cleared string setting is stored as '' which passes `z.string()`, so without this a blank
    // value would be returned verbatim instead of the default - stripping e.g. the artifact/help
    // prompts from completions and contradicting each setting's "clearing reverts to the built-in
    // default" contract. Only when the caller PASSED a default (defaultValue !== undefined) do we
    // treat '' as "use the default"; callers that omit it keep '' as a legitimate value (e.g.
    // FormatPromptTemplate, whose sole reader substitutes its own fallback for a blank).
    if (parsed.data === '' && defaultValue !== undefined) {
      return defaultValue;
    }
    return parsed.data as z.output<(typeof settingsMap)[K]['schema']>;
  } else {
    return defaultValue !== undefined
      ? defaultValue
      : (settingConfig.defaultValue as z.output<(typeof settingsMap)[K]['schema']>);
  }
}

/**
 * Retrieves all admin settings from the database and converts them into a key-value map.
 * Uses caching for improved performance.
 */
export async function getSettingsMap(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
  },
  options?: {
    logger?: Logger;
    skipCache?: boolean;
    /** If provided, only fetch the settings with the given names. */
    names?: IAdminSettings['settingName'][];
  }
): Promise<Record<string, string>> {
  const logger = options?.logger;

  // Allow bypassing cache for testing or when explicit fresh data is needed
  if (options?.skipCache) {
    const settings = options?.names
      ? await db.adminSettings.findBySettingNames(options.names)
      : await db.adminSettings.findAll();
    return settings.reduce(
      (out, s) => {
        out[s.settingName] = s.settingValue;
        return out;
      },
      {} as Record<string, string>
    );
  }

  // Use cached version
  const cache = getSettingsCache(logger);
  return cache.getSettingsMap(db);
}

/**
 * Get a single admin setting with caching
 */
export async function getSettingByName(
  settingName: Parameters<IAdminSettingsRepository['findBySettingName']>[0],
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingName'>;
  },
  options?: {
    logger?: Logger;
    skipCache?: boolean;
  }
): Promise<string | null> {
  const logger = options?.logger;

  // Allow bypassing cache for testing
  if (options?.skipCache) {
    const setting = await db.adminSettings.findBySettingName(settingName);
    // `?? null` (not `|| null`) so a stored boolean `false` survives - see AdminSettingsCache.
    return setting?.settingValue ?? null;
  }

  // Use cached version
  const cache = getSettingsCache(logger);
  return cache.getSettingByName(settingName, db);
}

/**
 * Get multiple admin settings in a single database query with caching
 */
export async function getSettingsByNames(
  settingNames: Parameters<IAdminSettingsRepository['findBySettingNames']>[0],
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findBySettingNames' | 'findAll'>;
  },
  options?: {
    logger?: Logger;
    skipCache?: boolean;
  }
): Promise<Record<string, string | null>> {
  const logger = options?.logger;

  // Allow bypassing cache for testing
  if (options?.skipCache) {
    const settings = await db.adminSettings.findBySettingNames(settingNames);
    const result: Record<string, string | null> = {};

    // Initialize all requested settings to null
    settingNames.forEach(name => {
      result[name] = null;
    });

    // Set values for found settings
    settings.forEach(setting => {
      result[setting.settingName] = setting.settingValue;
    });

    return result;
  }

  // Use cached version - fetch all and filter
  const cache = getSettingsCache(logger);
  const allSettings = await cache.getSettingsMap(db);

  const result: Record<string, string | null> = {};
  settingNames.forEach(name => {
    result[name] = allSettings[name] || null;
  });

  return result;
}

/**
 * Invalidate admin settings cache (useful when settings are updated)
 */
export function invalidateSettingsCache(settingName?: string): void {
  if (globalSettingsCache) {
    if (settingName) {
      globalSettingsCache.invalidateSetting(settingName);
    } else {
      globalSettingsCache.invalidateAll();
    }
  }
}

/**
 * Warm up the settings cache
 */
export async function warmUpSettingsCache(
  db: {
    adminSettings: Pick<IAdminSettingsRepository, 'findAll'>;
  },
  logger?: Logger
): Promise<void> {
  const cache = getSettingsCache(logger);
  await cache.warmUp(db);
}

/**
 * Graceful shutdown of settings cache (clears timers)
 */
export function shutdownSettingsCache(): void {
  if (globalSettingsCache) {
    globalSettingsCache.shutdown();
    globalSettingsCache = null;
  }
}

/**
 * Get cache statistics for monitoring
 */
export function getSettingsCacheStats() {
  return (
    globalSettingsCache?.getStats() || {
      totalEntries: 0,
      individualEntries: 0,
      memoryUsage: {
        approximate: '0KB',
        cacheSize: 0,
        individualCacheSize: 0,
      },
      environment: {
        isServerless: !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME),
        hasCleanupTimer: false,
      },
    }
  );
}
