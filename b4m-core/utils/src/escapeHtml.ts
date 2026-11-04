/**
 * Escape a string for safe interpolation into HTML text or a quoted attribute: & < > " '
 * in that order, so the ampersand pass cannot double-escape the entities the later passes
 * emit. The single shared copy for every HTML builder in the monorepo - email bodies
 * (`@bike4mind/services` notificationEmail, `@bike4mind/server-utils` emailHelpers) and the
 * app-layer publish viewer / artifact renderers all pin byte-identical output in their tests.
 *
 * Apply it to anything a user or operator can influence (names, emails, org and file names,
 * titles, URLs); never to a plain-text subject line, which is not HTML.
 *
 * Import from the lightweight subpath (`@bike4mind/utils/escapeHtml`), NOT the package
 * barrel - the barrel eagerly evaluates Logger/embedding-model code that breaks under
 * vitest suites which mock it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
