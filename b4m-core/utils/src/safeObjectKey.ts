/**
 * Guard against prototype pollution when an attacker- or model-controlled
 * string is used to index a plain object.
 *
 * Indexing a plain object with one of these keys reaches the prototype chain
 * instead of creating an own property: `obj['__proto__']` is `Object.prototype`,
 * `obj['constructor']` is its constructor, `obj['prototype']` the constructor's
 * prototype. Writing through them (`obj[key][x] = ...`) mutates
 * `Object.prototype` process-wide.
 *
 * Two complementary defenses:
 * - Build the container with `Object.create(null)` so any key (these included)
 *   is stored as a harmless own property with no prototype chain to reach.
 * - Call {@link assertSafeObjectKey} at the write boundary to reject a reserved
 *   name outright where a plain `{}` container cannot be avoided.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/safeObjectKey`), not
 * the package barrel, for the same reason as `escapeRegex`: the barrel eagerly
 * evaluates `Logger`/embedding-model code.
 */
export const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export function isForbiddenObjectKey(key: string): boolean {
  return FORBIDDEN_OBJECT_KEYS.has(key);
}

/**
 * Throw if `key` is a reserved name that would reach the prototype chain.
 * @param kind label for the value being keyed, used in the error message (e.g. 'entity', 'sheet').
 */
export function assertSafeObjectKey(key: string, kind = 'object key'): void {
  if (isForbiddenObjectKey(key)) {
    throw new Error(`Unsafe ${kind} "${key}": reserved name rejected to prevent prototype pollution`);
  }
}
