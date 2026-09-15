/**
 * Sanitizer for Help Assistant responses.
 *
 * The help model has no reliable way to know real documentation URLs - relevant
 * articles are surfaced separately as clickable links (the API's `relevantArticles`).
 * Left to itself it invents paths like `https://your-deployment.example.com/ai-models.md`,
 * which 404. The system prompt forbids links, but this is a belt-and-suspenders
 * pass that scrubs anything that slips through: fabricated markdown links (and
 * image links) collapse to their plain label text, and fabricated bare URLs (and
 * autolinks) are removed. Only the broken/guessed doc-link class is scrubbed -
 * app-domain URLs, any-host `.md` targets, and unsafe schemes (`javascript:`,
 * `data:`, ...). Genuine external links and legitimate `mailto:`/`tel:` contact
 * links (which the assistant is told to suggest) are left intact.
 */

// Matches inline links `[label](url)` and images `![label](url)`, capturing the
// label (group 1) and the bare destination (group 2). Handles the common CommonMark
// variants so fabricated links can't slip through on syntax alone:
//   - optional leading `!` (image) - part of the match, so it's dropped on collapse
//   - optional `<url>` angle-bracket wrapping (brackets excluded from the capture)
//   - optional trailing title: `"..."`, `'...'`, or `(...)`
//   - one level of balanced parentheses in the URL (e.g. `doc_(v2).md`)
// Reference-style links (`[label][ref]`) are intentionally out of scope - an LLM
// chat reply won't emit the separate `[ref]: url` definition they require.
const MARKDOWN_LINK_RE = /!?\[([^\]]+)\]\(\s*<?((?:[^()\s]+|\([^)]*\))+?)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;

// Matches a bare http(s) URL plus any leading whitespace, including CommonMark
// autolink `<url>` wrapping (the `<>` are consumed so nothing is orphaned when the
// URL is removed). Stops before closing brackets/whitespace. Trailing sentence
// punctuation is handled separately so it survives when the URL itself is removed.
// Intentionally http(s)-only: a bare unsafe scheme as plain text (e.g. `javascript:...`
// not in a markdown link) isn't a clickable href - MarkdownViewer governs what
// renders as <a> - so there's nothing to neutralize here.
const BARE_URL_RE = /(\s*)<?(https?:\/\/[^\s)\]}>]+)>?/gi;
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/;

// Schemes that point at a real, user-actionable destination. mailto:/tel: are
// legitimate contact links (no doc path to hallucinate); anything not listed -
// `javascript:`, `data:`, etc. - is treated as a fabricated/unsafe link.
const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

// The app's own domain is derived from SERVER_DOMAIN with no brand fallback. When unset,
// the app-domain check below is skipped (the `.md` heuristic still catches fabricated
// doc paths on any host).
const SERVER_DOMAIN = process.env.SERVER_DOMAIN || '';
const APP_DOMAIN_RE = SERVER_DOMAIN
  ? new RegExp(`(^|\\.)${SERVER_DOMAIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  : null;

export function isFabricatedDocLink(url: string): boolean {
  let parsed: URL;
  try {
    // Parse so domain/extension checks target the hostname and pathname only - a
    // genuine external link must never be flagged just for mentioning the app domain
    // or ".md" somewhere in its query string or fragment.
    parsed = new URL(url.trim());
  } catch {
    // Relative paths, bare anchors, and other non-absolute targets aren't navigable here
    return true;
  }
  // Unsafe/unknown schemes (javascript:, data:, ...) are never legitimate links here
  if (!SAFE_LINK_SCHEMES.has(parsed.protocol)) return true;
  // mailto:/tel: have no doc path to fake - they're legitimate contact links, keep them
  if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') return false;
  // Links into the app's own domain are guesses - real nav uses the help panel
  if (APP_DOMAIN_RE && APP_DOMAIN_RE.test(parsed.hostname)) return true;
  // Any link pointing at a markdown file is a doc-path hallucination (allow a
  // trailing slash, e.g. `/ai-models.md/`, which is still a guessed doc path)
  if (/\.md\/?$/i.test(parsed.pathname)) return true;
  return false;
}

export function stripFabricatedLinks(text: string): string {
  return (
    text
      // `[label](url)` / `![label](url)` -> label, when the target is fabricated
      .replace(MARKDOWN_LINK_RE, (match, label: string, url: string) => (isFabricatedDocLink(url) ? label : match))
      // bare fabricated URLs -> removed, preserving trailing sentence punctuation
      .replace(BARE_URL_RE, (match, _leading: string, rawUrl: string) => {
        const trailing = rawUrl.match(TRAILING_PUNCTUATION_RE)?.[0] ?? '';
        const url = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;
        return isFabricatedDocLink(url) ? trailing : match;
      })
  );
}
