/**
 * SystemSecrets Manager
 *
 * Handles resolution of system secrets with database-first fallback to SST.
 * Provides caching for performance and supports the admin GUI override pattern.
 *
 * Resolution order:
 * 1. Check SystemSecrets collection for GUI-configured or auto-generated value
 * 2. Fall back to SST Resource value
 * 3. Return undefined if neither exists
 *
 * Security notes:
 * - Tier 1 secrets (SECRET_ENCRYPTION_KEY, MONGODB_URI, SESSION_SECRET) NEVER use this
 *   They are read directly from SST/Config and should never be in the database.
 * - All database values are encrypted with AES-256-GCM using SECRET_ENCRYPTION_KEY
 */

import { Resource } from 'sst';
import { systemSecretRepository, SystemSecretCategory } from '@bike4mind/database';
import { isPlaceholderValue } from '@bike4mind/common';
import { decryptSecret, isValidEncryptionKey } from '../security/secretEncryption';
import { Config } from '../utils/config';

/**
 * Result of secret resolution for debugging/logging.
 */
export interface SecretResolutionResult {
  value?: string;
  source: 'database' | 'sst' | null;
  warnings?: string[];
}

/**
 * Secrets that are Tier 1 (SST only) and should NEVER be resolved via database.
 * These must be read directly from Config/Resource.
 * Exported for use by tier1-status API endpoint.
 */
export const TIER1_SECRETS = new Set(['SECRET_ENCRYPTION_KEY', 'MONGODB_URI', 'SESSION_SECRET', 'JWT_SECRET']);

/**
 * Cache for resolved secrets to avoid repeated database lookups.
 * Uses a simple in-memory cache with TTL.
 */
const secretCache = new Map<
  string,
  {
    value: string | undefined;
    source: 'database' | 'sst' | null;
    expiresAt: number;
  }
>();

/**
 * Cache TTL in milliseconds (5 minutes, matching oktaOidcClient pattern).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Clears the secret cache. Should be called when secrets are updated via admin API.
 */
export function clearSecretCache(secretName?: string): void {
  if (secretName) {
    secretCache.delete(secretName);
  } else {
    secretCache.clear();
  }
}

/**
 * Gets a secret value using database-first resolution with SST fallback.
 *
 * @param secretName - The name of the secret (e.g., 'JWT_SECRET', 'MAIL_HOST')
 * @param skipCache - If true, bypasses the cache and fetches fresh value
 * @returns The secret value or undefined if not found
 * @throws Error if the secret is a Tier 1 secret (use Config directly instead)
 */
export async function getSecret(secretName: string, skipCache = false): Promise<string | undefined> {
  const result = await resolveSecret(secretName, skipCache);
  return result.value;
}

/**
 * Resolves a secret with full result including source and warnings.
 * Useful for admin UI to show where secrets are configured.
 *
 * @param secretName - The name of the secret
 * @param skipCache - If true, bypasses the cache
 * @returns Resolution result with value, source, and any warnings
 */
export async function resolveSecret(secretName: string, skipCache = false): Promise<SecretResolutionResult> {
  // Tier 1 secrets must NEVER be resolved via database
  if (TIER1_SECRETS.has(secretName)) {
    throw new Error(
      `${secretName} is a Tier 1 secret and must be read directly from Config. ` +
        `Never use systemSecretsManager for Tier 1 secrets.`
    );
  }

  // Check cache first
  if (!skipCache) {
    const cached = secretCache.get(secretName);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        value: cached.value,
        source: cached.source,
      };
    }
  }

  const warnings: string[] = [];

  // Step 1: Try to get from database
  try {
    const dbSecret = await systemSecretRepository.findBySecretName(secretName);

    if (dbSecret) {
      const encryptionKey = Config.SECRET_ENCRYPTION_KEY;

      if (!encryptionKey || !isValidEncryptionKey(encryptionKey)) {
        warnings.push('SECRET_ENCRYPTION_KEY is invalid, cannot decrypt database secrets');
      } else {
        try {
          const decryptedValue = decryptSecret(dbSecret.encryptedValue, encryptionKey);

          // Cache the result
          secretCache.set(secretName, {
            value: decryptedValue,
            source: 'database',
            expiresAt: Date.now() + CACHE_TTL_MS,
          });

          return {
            value: decryptedValue,
            source: 'database',
            warnings: warnings.length > 0 ? warnings : undefined,
          };
        } catch (decryptError) {
          warnings.push(`Failed to decrypt ${secretName}: ${(decryptError as Error).message}`);
          // Fall through to SST fallback
        }
      }
    }
  } catch (dbError) {
    // Database error - log and fall through to SST
    warnings.push(`Database error for ${secretName}: ${(dbError as Error).message}`);
  }

  // Step 2: Fall back to SST
  try {
    const sstValue = (Resource as unknown as Record<string, { value?: string }>)[secretName]?.value;

    if (sstValue && !isPlaceholderValue(sstValue)) {
      // Cache the result
      secretCache.set(secretName, {
        value: sstValue,
        source: 'sst',
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return {
        value: sstValue,
        source: 'sst',
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
  } catch {
    // SST Resource not available (e.g., in tests)
    warnings.push(`SST Resource ${secretName} not available`);
  }

  // Step 3: Not found anywhere
  secretCache.set(secretName, {
    value: undefined,
    source: null,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return {
    value: undefined,
    source: null,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Gets all overridable secrets with their resolution status.
 * Used by admin UI to show the current configuration state.
 */
export async function getSecretsStatus(): Promise<
  Array<{
    secretName: string;
    category: SystemSecretCategory;
    source: 'database' | 'sst' | null;
    isConfigured: boolean;
    isOverridable: boolean;
    description?: string;
    warnings?: string[];
  }>
> {
  const dbSecrets = await systemSecretRepository.findAll();
  const results: Array<{
    secretName: string;
    category: SystemSecretCategory;
    source: 'database' | 'sst' | null;
    isConfigured: boolean;
    isOverridable: boolean;
    description?: string;
    warnings?: string[];
  }> = [];

  for (const dbSecret of dbSecrets) {
    const resolution = await resolveSecret(dbSecret.secretName, true);
    results.push({
      secretName: dbSecret.secretName,
      category: dbSecret.category,
      source: resolution.source,
      isConfigured: !!resolution.value,
      isOverridable: dbSecret.isOverridable,
      description: dbSecret.description,
      warnings: resolution.warnings,
    });
  }

  return results;
}

/**
 * Gets a batch of secrets at once for efficiency.
 *
 * @param secretNames - Array of secret names to fetch
 * @returns Map of secret name to value (undefined if not found)
 */
export async function getSecretsBatch(secretNames: string[]): Promise<Map<string, string | undefined>> {
  const results = new Map<string, string | undefined>();

  const validSecretNames = secretNames.filter(name => !TIER1_SECRETS.has(name));

  await Promise.all(
    validSecretNames.map(async name => {
      const value = await getSecret(name);
      results.set(name, value);
    })
  );

  return results;
}

/**
 * Configuration for secrets that can be resolved via this manager.
 * Tier 3 secrets only (GUI-configurable).
 * Tier 1 secrets (SECRET_ENCRYPTION_KEY, MONGODB_URI, SESSION_SECRET, JWT_SECRET)
 * must be set via SST CLI and are NOT included here.
 */
export const RESOLVABLE_SECRETS = {
  // Mail
  MAIL_HOST: {
    category: 'mail' as SystemSecretCategory,
    description: 'SMTP server hostname',
  },
  MAIL_PORT: {
    category: 'mail' as SystemSecretCategory,
    description: 'SMTP server port',
  },
  MAIL_USERNAME: {
    category: 'mail' as SystemSecretCategory,
    description: 'SMTP authentication username',
  },
  MAIL_PASSWORD: {
    category: 'mail' as SystemSecretCategory,
    description: 'SMTP authentication password',
  },
  MAIL_FROM: {
    category: 'mail' as SystemSecretCategory,
    description: 'Default sender email address',
  },
  SUPPORT_EMAIL: {
    category: 'mail' as SystemSecretCategory,
    description: 'Support contact email address',
  },

  // OAuth
  GOOGLE_CLIENT_ID: {
    category: 'oauth' as SystemSecretCategory,
    description: 'Google OAuth client ID',
  },
  GOOGLE_CLIENT_SECRET: {
    category: 'oauth' as SystemSecretCategory,
    description: 'Google OAuth client secret',
  },
  GITHUB_CLIENT_ID: {
    category: 'oauth' as SystemSecretCategory,
    description: 'GitHub OAuth client ID',
  },
  GITHUB_CLIENT_SECRET: {
    category: 'oauth' as SystemSecretCategory,
    description: 'GitHub OAuth client secret',
  },

  // API Keys
  ANTHROPIC_API_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Anthropic Claude API key',
  },
  GEMINI_API_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Google Gemini API key',
  },
  STRIPE_SECRET_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Stripe secret API key',
  },
  STRIPE_PUBLISHABLE_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Stripe publishable key',
  },
  STRIPE_WEBHOOK_SECRET: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Stripe webhook signing secret',
  },

  // Slack
  SLACK_WEBHOOK_URL: {
    category: 'slack' as SystemSecretCategory,
    description: 'Slack webhook URL for notifications',
  },
  SLACK_ERROR_REPORTING_WEBHOOK_URL: {
    category: 'slack' as SystemSecretCategory,
    description: 'Slack webhook URL for error reporting',
  },

  // Financial Data
  FMP_API_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'Financial Modeling Prep API key for stock market data',
  },

  // Procedural RPG content
  POTIONQUEST_API_KEY: {
    category: 'api_key' as SystemSecretCategory,
    description: 'PotionQuest API key for procedural RPG content generation (potionquest.com)',
  },
} as const;

export type ResolvableSecretName = keyof typeof RESOLVABLE_SECRETS;
