/**
 * Escape regex special characters in user-controlled input before it is used
 * as a MongoDB `$regex` operand (or in a `new RegExp(...)`).
 *
 * Passing raw user input to `$regex` is a security antipattern: unescaped
 * metacharacters allow
 * - ReDoS / DoS: a crafted catastrophic-backtracking pattern (e.g. `(a+)+$`)
 *   pins the query until timeout, and
 * - query manipulation: anchors/wildcards (`.*`, `^`, `$`) broaden or redirect
 *   the match beyond the intended scope.
 *
 * Escape every user-controlled operand with this before it reaches `$regex`.
 * For exact-match lookups (e.g. login by username/email), anchor the escaped
 * value with `^...$`.
 *
 * Import this from the lightweight subpath (`@bike4mind/utils/escapeRegex`),
 * NOT the package barrel (`@bike4mind/utils`). The barrel eagerly evaluates
 * `Logger`/embedding-model code; pulling it into a server module that a client
 * vitest suite mocks throws `TypeError: Logger is not a constructor`.
 *
 * @example
 * { username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' } } // exact match
 * { name: { $regex: escapeRegex(search), $options: 'i' } }             // contains
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
