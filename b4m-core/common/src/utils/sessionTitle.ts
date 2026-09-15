/**
 * Canonical session-title sanitizer.
 *
 * Some persisted sessions store a raw JSON literal as their `name` - the
 * auto-namer used to write LLM output verbatim (e.g. `{ "editorialMode": ... }`).
 * Rendering that directly shows JSON as the title and, because the visible text
 * node doubles as a button's accessible name, makes a screen reader announce the
 * entire (sometimes multi-KB) blob.
 *
 * This single implementation serves both runtimes:
 *  - server: sanitize an LLM-produced title before persisting (auto-namer)
 *  - client: clean up already-persisted broken names at display time
 *
 * It is re-exported as `sanitizeSessionTitle` (server) and `formatSessionTitle`
 * (client) so existing call sites keep their semantic name.
 */
const MAX_TITLE_LENGTH = 80;

export function formatSessionTitle(raw: string | undefined | null, maxLength = MAX_TITLE_LENGTH): string {
  const fallback = 'Untitled session';
  if (!raw) return fallback;

  let title = raw.trim();

  // If the model echoed a JSON object/array, pull out a sensible label.
  if ((title.startsWith('{') && title.endsWith('}')) || (title.startsWith('[') && title.endsWith(']'))) {
    try {
      const parsed = JSON.parse(title);
      if (parsed && typeof parsed === 'object') {
        const labeled = !Array.isArray(parsed)
          ? [parsed.headline, parsed.title, parsed.name, parsed.subject].find(
              (v: unknown) => typeof v === 'string' && v.trim().length > 0
            )
          : undefined;
        const firstString = Object.values(parsed).find((v: unknown) => typeof v === 'string' && v.trim().length > 0);
        title = String(labeled ?? firstString ?? fallback);
      }
    } catch {
      // Not valid JSON after all - treat as plain text.
    }
  }

  // Collapse newlines/whitespace and strip wrapping quotes/asterisks the model
  // sometimes adds despite the prompt instruction.
  title = title
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^["'*`_\s]+|["'*`_\s]+$/g, '')
    .trim();

  if (!title) return fallback;

  if (title.length > maxLength) {
    // Spread to iterate by code point so the clamp never splits a surrogate pair
    // (e.g. an emoji) and leaves a lone half.
    title =
      [...title]
        .slice(0, maxLength - 1)
        .join('')
        .trimEnd() + '…';
  }

  return title;
}

/** Server-side alias - sanitize an LLM title before persisting. */
export const sanitizeSessionTitle = formatSessionTitle;
