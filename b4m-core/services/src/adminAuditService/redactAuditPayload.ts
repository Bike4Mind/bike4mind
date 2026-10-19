const SECRET_KEY_PATTERN = /password|secret|token|apikey|hash|credential/i;
const REDACTED = '[REDACTED]';

export const isSecretKey = (key: string): boolean => SECRET_KEY_PATTERN.test(key);

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
