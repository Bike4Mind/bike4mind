/**
 * Shared parsing/validation for the `locale` request parameter used across the
 * help endpoints (index API now; retrieval later). Keeping it here rather than in
 * a `pages/` file avoids Next treating it as a route, and lets it be unit-tested
 * without importing the passport/baseApi middleware graph.
 */

/**
 * Extract a single string from an Express query value, which may be a string, an
 * array, or a nested `ParsedQs` object. Returns the first string, or undefined for
 * anything non-string (e.g. `?locale[x]=y`), so callers never receive an object.
 */
export function firstQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Validate a requested locale used to build a generated file path. Accepts a
 * BCP-47-ish shape (`es`, `fil`, `zh-CN`) and returns it VERBATIM so it matches
 * the case of the i18n directory / generated `help-index.<locale>.json` (e.g.
 * `zh-CN`, not `zh-cn`). Anything else - including path separators, dots, or
 * empty - falls back to `'en'`. This is the guard against filesystem traversal.
 */
export function sanitizeLocale(raw: string | undefined): string {
  if (!raw) return 'en';
  const trimmed = raw.trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(trimmed) ? trimmed : 'en';
}
