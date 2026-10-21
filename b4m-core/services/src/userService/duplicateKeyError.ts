/**
 * True for a MongoDB E11000 raised by a unique index on `field` (keyPattern, falling back to
 * keyValue for drivers that omit it).
 */
export function isDuplicateKeyErrorOn(error: unknown, field: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, keyPattern, keyValue } = error as {
    code?: unknown;
    keyPattern?: Record<string, unknown>;
    keyValue?: Record<string, unknown>;
  };
  if (code !== 11000) return false;
  return Boolean((keyPattern && field in keyPattern) || (keyValue && field in keyValue));
}
