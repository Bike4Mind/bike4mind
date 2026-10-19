import type { AuditChange } from '@bike4mind/common';

// `token` alone over-matches (maxTokens, tokenEndpointAuthMethod), so it only counts as the whole key
// or as a camelCase / snake / kebab suffix (accessToken, refresh_token, id-token).
const SECRET_SUBSTRING_PATTERN = /password|secret|apikey|api_key|hash|credential/i;
const TOKEN_KEY_PATTERNS = [/^token$/i, /Token$/, /[_-]token$/i];
const REDACTED = '[REDACTED]';

export const isSecretKey = (key: string): boolean =>
  SECRET_SUBSTRING_PATTERN.test(key) || TOKEN_KEY_PATTERNS.some(pattern => pattern.test(key));

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const redact = (value: unknown, ancestors: WeakSet<object>): unknown => {
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return '[CIRCULAR]';
    ancestors.add(value);
    const result = value.map(item => redact(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (!isPlainObject(value)) return value;
  if (ancestors.has(value)) return '[CIRCULAR]';
  ancestors.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSecretKey(key) ? REDACTED : redact(child, ancestors);
  }
  ancestors.delete(value);
  return result;
};

/**
 * Returns a copy with every value under a secret-looking key replaced, at any depth
 * (including inside arrays). Dates and other class instances are left untouched.
 */
export const redactAuditPayload = <T>(value: T): T => redact(value, new WeakSet()) as T;

export const REDACTED_PLACEHOLDER = REDACTED;

// A change row names its field in a value, so key-based redaction alone would miss it.
export const redactChange = (change: AuditChange): AuditChange =>
  isSecretKey(change.field) ? { field: change.field, before: REDACTED, after: REDACTED } : redactAuditPayload(change);
