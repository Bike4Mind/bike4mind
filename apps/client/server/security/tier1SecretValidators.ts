/**
 * Tier 1 Secret Validators
 *
 * Shared validation logic for infrastructure secrets used by both:
 * - System Secrets admin page (tier1-status.ts)
 * - System Health admin page (system-health.ts)
 *
 * This ensures consistent validation behavior across all admin UIs.
 *
 * Security requirements based on industry best practices:
 * - JWT_SECRET: 64+ chars for optimal HS256 security (256+ bits entropy)
 * - SESSION_SECRET: 32+ chars (express-session recommendation)
 * - SECRET_ENCRYPTION_KEY: exactly 64 hex chars (AES-256 requirement)
 * - MONGODB_URI: valid scheme, no localhost in production
 */
import { SST_PLACEHOLDER_VALUE } from '@bike4mind/common';
import { isValidEncryptionKey } from './secretEncryption';

/**
 * Validation severity levels.
 */
export type ValidationSeverity = 'error' | 'warning' | 'info';

/**
 * Validation status types.
 */
export type ValidationStatus = 'configured' | 'placeholder' | 'invalid' | 'missing' | 'warning' | 'insecure';

/**
 * Shared Tier 1 secret validation results.
 * Used by both System Secrets and System Health pages.
 */
export interface Tier1ValidationResult {
  isValid: boolean;
  status: ValidationStatus;
  severity: ValidationSeverity;
  message?: string;
}

/**
 * Minimum required length for JWT_SECRET (security requirement).
 * HS256 needs 256+ bits of entropy; 64 base64 chars provides ~384 bits.
 */
export const JWT_SECRET_MIN_LENGTH = 64;

/**
 * Warning threshold for JWT_SECRET.
 * Secrets between 32-64 chars work but are not optimal.
 */
export const JWT_SECRET_WARN_LENGTH = 32;

/**
 * Minimum required length for SESSION_SECRET.
 * Express-session recommends at least 32 bytes of entropy.
 */
export const SESSION_SECRET_MIN_LENGTH = 32;

/**
 * Common placeholder values to detect.
 */
const COMMON_PLACEHOLDERS = [
  SST_PLACEHOLDER_VALUE,
  'not-configured',
  'changeme',
  'change_me',
  'your_secret_here',
  'your-secret-key',
  'replace-me',
  'xxx',
  'todo',
  'fixme',
];

/**
 * Checks if a value is a common placeholder.
 */
function isCommonPlaceholder(value: string): boolean {
  const lower = value.toLowerCase();
  return COMMON_PLACEHOLDERS.some(p => lower === p.toLowerCase());
}

/**
 * Checks if a value has low entropy (repeated characters).
 */
function isLowEntropy(value: string): boolean {
  // Detect repeated single character (e.g., 'aaaaaaa...')
  return /^(.)\1{15,}$/.test(value);
}

/**
 * Validates SECRET_ENCRYPTION_KEY.
 * Must be exactly 64 hex characters (32 bytes for AES-256).
 */
export function validateEncryptionKey(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (!isValidEncryptionKey(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Must be exactly 64 hexadecimal characters (32 bytes)',
    };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Key appears to be low-entropy (repeated characters)',
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

/**
 * Validates MONGODB_URI.
 * Must start with mongodb:// or mongodb+srv://.
 * Warns about localhost in production.
 */
export function validateMongoUri(value: string | undefined, stage?: string): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (!value.startsWith('mongodb://') && !value.startsWith('mongodb+srv://')) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Must start with mongodb:// or mongodb+srv://',
    };
  }
  // Warn about localhost in production
  const isProduction = stage === 'prod' || stage === 'production';
  const isLocalhost = value.includes('localhost') || value.includes('127.0.0.1');
  if (isProduction && isLocalhost) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'localhost MongoDB should not be used in production',
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

/**
 * Validates SESSION_SECRET.
 * Must be at least 32 characters.
 */
export function validateSessionSecret(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Secret appears to be low-entropy (repeated characters)',
    };
  }
  if (value.length < SESSION_SECRET_MIN_LENGTH) {
    return {
      isValid: false,
      status: 'insecure',
      severity: 'error',
      message: `Only ${value.length} characters. Must be at least ${SESSION_SECRET_MIN_LENGTH} for security.`,
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}

/**
 * Validates JWT_SECRET.
 * Must be at least 64 characters for optimal security.
 * Warns if between 32-64 characters.
 */
export function validateJwtSecret(value: string | undefined): Tier1ValidationResult {
  if (!value) {
    return { isValid: false, status: 'missing', severity: 'error' };
  }
  if (isCommonPlaceholder(value)) {
    return { isValid: false, status: 'placeholder', severity: 'error' };
  }
  if (isLowEntropy(value)) {
    return {
      isValid: false,
      status: 'invalid',
      severity: 'error',
      message: 'Secret appears to be low-entropy (repeated characters)',
    };
  }
  if (value.length < JWT_SECRET_WARN_LENGTH) {
    return {
      isValid: false,
      status: 'insecure',
      severity: 'error',
      message: `Only ${value.length} characters. Must be at least ${JWT_SECRET_WARN_LENGTH} for security.`,
    };
  }
  if (value.length < JWT_SECRET_MIN_LENGTH) {
    return {
      isValid: true, // Still valid, but not optimal
      status: 'warning',
      severity: 'warning',
      message: `Only ${value.length} characters. Recommend ${JWT_SECRET_MIN_LENGTH}+ for optimal security.`,
    };
  }
  return { isValid: true, status: 'configured', severity: 'info' };
}
