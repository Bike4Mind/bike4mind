import { IBaseRepository } from './BaseTypes';
import { IMongoDocument } from './common';

/**
 * Placeholder value used by SST for unset secrets.
 * Used to detect when a secret needs to be configured.
 */
export const SST_PLACEHOLDER_VALUE = 'my-secret-placeholder-value';

/**
 * Placeholder value for optional secrets that haven't been configured.
 * Services should check for this value and gracefully degrade.
 * @security This is a RESERVED value - never use as an actual secret.
 */
export const NOT_CONFIGURED_PLACEHOLDER = 'not-configured';

/**
 * Check if a value is a placeholder (not configured or SST default).
 * Uses case-insensitive comparison and trims whitespace to prevent bypass attempts.
 * @param value - The secret value to check
 * @returns true if the value is a placeholder or empty/null/undefined
 * @security This detects RESERVED values that should never be used as actual secrets.
 */
export function isPlaceholderValue(value: string | undefined | null): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized === SST_PLACEHOLDER_VALUE.toLowerCase() || normalized === NOT_CONFIGURED_PLACEHOLDER.toLowerCase();
}

/**
 * Distinctive dummy tokens that mark an API-key value as a placeholder rather than a real
 * credential. Matched only as a whole hyphen-delimited segment (see PLACEHOLDER_API_KEY_REGEX),
 * so a token can hit a deliberately-labelled placeholder but not the contiguous random body of a
 * real key. Keep this set tight: a false positive rejects a paying user's real key, which is
 * worse than the downstream 401 this guards against.
 */
const PLACEHOLDER_API_KEY_TOKENS = [
  'dummy',
  'placeholder',
  'change-?me',
  'replace-?me',
  'your-?(api-?)?key',
  'not-a-real',
  'example',
];

const PLACEHOLDER_API_KEY_REGEX = new RegExp(`(^|-)(${PLACEHOLDER_API_KEY_TOKENS.join('|')})(-|$)`);

/**
 * Is this API-key value a placeholder/dummy rather than a real credential? Superset of
 * isPlaceholderValue (so empty/null/SST sentinels are caught too) plus a small set of distinctive
 * dummy tokens matched only as whole hyphen-delimited segments. Underscores are normalized to
 * hyphens first so REPLACE_ME / YOUR_API_KEY are caught, and a whitespace-only value counts as a
 * placeholder. Conservative by design: real OpenAI/Voyage keys are a known prefix plus a
 * contiguous base62 body with no hyphen-delimited dummy word, so this must never reject one - when
 * a value isn't a recognized placeholder it returns false and the caller surfaces the real error.
 */
export function isPlaceholderApiKey(value: string | undefined | null): boolean {
  if (isPlaceholderValue(value)) return true;
  const normalized = (value ?? '').trim().toLowerCase().replace(/_/g, '-');
  if (!normalized) return true;
  return PLACEHOLDER_API_KEY_REGEX.test(normalized);
}

/**
 * Category of system secret.
 * - auth: Authentication secrets (JWT_SECRET)
 * - mail: Email configuration secrets
 * - oauth: OAuth provider credentials
 * - api_key: Third-party API keys
 * - slack: Slack integration secrets
 */
export type SystemSecretCategory = 'auth' | 'mail' | 'oauth' | 'api_key' | 'slack';

/**
 * Source of the secret value.
 * - auto_generated: Generated automatically on first deployment
 * - gui_configured: Set by admin via GUI
 * - sst_migrated: Migrated from SST secrets
 */
export type SystemSecretSource = 'auto_generated' | 'gui_configured' | 'sst_migrated';

/**
 * System secret interface for GUI-configurable secrets.
 *
 * NOTE: Tier 1 secrets (SECRET_ENCRYPTION_KEY, MONGODB_URI, SESSION_SECRET)
 * are NEVER stored in this collection - they remain in SST/AWS SSM only.
 */
export interface ISystemSecret {
  id: string;
  /** Secret name matching SST secret name (e.g., 'JWT_SECRET', 'MAIL_HOST') */
  secretName: string;
  /** AES-256-GCM encrypted value in format: iv:authTag:ciphertext */
  encryptedValue: string;
  /** Previous encrypted value for rollback support */
  previousEncryptedValue?: string;
  /** Encryption key version used (for key rotation support) */
  keyVersion: number;
  /** Category of this secret */
  category: SystemSecretCategory;
  /** How this secret value was set */
  source: SystemSecretSource;
  /** Whether this secret can be modified via admin GUI */
  isOverridable: boolean;
  /** Human-readable description of this secret */
  description?: string;
  /** User ID who last modified this secret */
  lastModifiedBy?: string;
  /** When this secret was last rotated */
  rotatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ISystemSecretDocument extends ISystemSecret, IMongoDocument {}

export interface ISystemSecretRepository extends IBaseRepository<ISystemSecretDocument> {
  /** Find a secret by its name */
  findBySecretName: (secretName: string) => Promise<ISystemSecretDocument | null>;
  /** Find all overridable secrets */
  findOverridableSecrets: () => Promise<ISystemSecretDocument[]>;
  /** Find all secrets in a category */
  findByCategory: (category: SystemSecretCategory) => Promise<ISystemSecretDocument[]>;
  /** Find all secrets */
  findAll: () => Promise<ISystemSecretDocument[]>;
  /**
   * Atomically upsert a secret (prevents race conditions).
   * Uses $setOnInsert for initial creation.
   */
  upsertSecret: (secretName: string, data: Partial<ISystemSecretDocument>) => Promise<ISystemSecretDocument>;
  /** Update an existing secret */
  updateSecret: (id: string, data: Partial<ISystemSecretDocument>) => Promise<ISystemSecretDocument | null>;
  /** Delete a secret by ID */
  deleteSecret: (id: string) => Promise<boolean>;
}

/**
 * Audit events for secret operations (for compliance logging).
 */
export enum SecretAuditEvents {
  SECRET_CREATED = 'SECRET_CREATED',
  SECRET_ACCESSED = 'SECRET_ACCESSED',
  SECRET_MODIFIED = 'SECRET_MODIFIED',
  SECRET_ROTATED = 'SECRET_ROTATED',
  SECRET_DELETED = 'SECRET_DELETED',
  INVALID_KEY_DETECTED = 'INVALID_KEY_DETECTED',
  DECRYPTION_FAILED = 'DECRYPTION_FAILED',
}

/**
 * Configuration for secrets that can be auto-generated.
 */
export interface AutoGeneratableSecretConfig {
  /** Secret name */
  secretName: string;
  /** Category */
  category: SystemSecretCategory;
  /** Whether it can be overridden via GUI */
  isOverridable: boolean;
  /** Human-readable description */
  description: string;
  /** Minimum length for validation */
  minLength?: number;
  /** Validation pattern (regex) */
  validationPattern?: RegExp;
  /** Error message for validation failure */
  validationError?: string;
}

/**
 * Result of secret resolution (for debugging/logging).
 */
export interface SecretResolutionResult {
  /** The resolved secret value (or undefined if not found) */
  value?: string;
  /** Where the secret was resolved from */
  source: 'database' | 'sst' | 'auto_generated' | null;
  /** Any warnings about the secret (e.g., weak value) */
  warnings?: string[];
}
