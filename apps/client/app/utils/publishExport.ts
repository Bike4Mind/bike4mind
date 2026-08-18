/**
 * Export affordances for published artifacts (issue #1142): which formats a given
 * artifact kind converts to WITHOUT loss, the `?export=` URLs, the download
 * filenames, and the CSP-safe footer markup.
 *
 * Shared by the serve route (which renders the footer and answers `?export=`) and
 * the app-side Published tab, so both agree on what may be offered. Pure string /
 * data helpers with no imports beyond the escaper - the serve surfaces run under
 * `script-src 'none'`, so anything here must work with zero JS.
 *
 * PDF is not a server `?export=` format: it is produced client-side on the owner
 * path (the Published tab) by printing the HTML export from an isolated sandboxed
 * frame - see printToPdf.ts. The CSP-locked viewer footers still cannot offer it
 * (the reply/fabfile page is served `script-src 'none'`, and the bundle wrapper's
 * script-src admits only the comment widget), so PDF stays owner-only.
 */

import { escapeAttr } from './htmlEscape';

export type PublishExportFormat = 'md' | 'html';

export type PublishSourceKindName = 'bundle' | 'reply' | 'fabfile';

/**
 * Formats a FAITHFUL conversion exists for, per publish source kind. Anything not
 * listed is withheld rather than emitted lossily:
 *
 *  - reply:   `renderedBody` IS the assistant's markdown, so `md` round-trips
 *             exactly; `html` is that same body rendered.
 *  - fabfile: literal file text of unknown syntax. Fencing arbitrary bytes and
 *             calling the result Markdown would be a fabrication, so `md` is
 *             withheld; `html` reproduces the text verbatim in a <pre>.
 *  - bundle:  `index.html` IS the artifact. React/HTML/SVG have no faithful
 *             Markdown form, so only `html` is offered.
 */
export function exportFormatsFor(kind: PublishSourceKindName): PublishExportFormat[] {
  return kind === 'reply' ? ['md', 'html'] : ['html'];
}

export function supportsExport(kind: PublishSourceKindName, format: PublishExportFormat): boolean {
  return exportFormatsFor(kind).includes(format);
}

/** Response Content-Type per export format. */
export const EXPORT_CONTENT_TYPE: Record<PublishExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

const EXPORT_EXTENSION: Record<PublishExportFormat, string> = { md: 'md', html: 'html' };

const EXPORT_LABEL: Record<PublishExportFormat, string> = { md: 'Markdown', html: 'HTML' };

/** Narrow an untrusted query value to a supported format, or null. */
export function parseExportFormat(raw: unknown): PublishExportFormat | null {
  return raw === 'md' || raw === 'html' ? raw : null;
}

/**
 * Download filename for an export. ASCII-only and quote-free so it can go into a
 * `Content-Disposition: attachment; filename="..."` header unescaped.
 */
export function exportFilename(title: string, format: PublishExportFormat): string {
  const stem =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'artifact';
  return `${stem}.${EXPORT_EXTENSION[format]}`;
}

/** `?export=` URL for a viewer path (`/p/r/{id}`, `/p/u/{scope}/{slug}`, `/a/{token}`). */
export function exportHref(viewerPath: string, format: PublishExportFormat): string {
  return `${viewerPath}?export=${format}`;
}

/**
 * A published artifact rendered as a Markdown document: the title as an H1, the
 * description, then the body verbatim. Matches the shape `?format=raw` already
 * emits, so the two text views of an artifact agree.
 */
export function buildMarkdownExport(title: string, description: string | undefined, body: string): string {
  const parts = [`# ${title}`];
  const desc = description?.trim();
  if (desc) parts.push('', desc);
  const trimmed = body.trim();
  if (trimmed) parts.push('', trimmed);
  return `${parts.join('\n')}\n`;
}

/**
 * Export links for a viewer footer: plain `download` anchors, no JS, so they stay
 * valid under `script-src 'none'`. Returns '' when there is nothing offerable.
 *
 * Callers must only render these where a credential-free navigation will
 * re-authorize (open-public, `/a/<token>` share, or a passphrase-verified gate) -
 * a Bearer-gated artifact would answer the click with the loader shell instead of
 * a file. Owners reach the same exports through the Published tab, which does
 * carry a credential.
 */
export function buildExportActionsHtml(viewerPath: string, formats: readonly PublishExportFormat[]): string {
  if (!viewerPath || formats.length === 0) return '';
  const links = formats
    .map(
      f =>
        `<a href="${escapeAttr(exportHref(viewerPath, f))}" download` +
        ` style="color:#94a3b8;text-decoration:none">&#8681; ${EXPORT_LABEL[f]}</a>`
    )
    .join('<span style="opacity:.4">&middot;</span>');
  return (
    `<div style="margin-top:10px;display:flex;justify-content:center;gap:10px;font-size:11.5px;` +
    `font-family:ui-sans-serif,system-ui,-apple-system,sans-serif">${links}</div>`
  );
}
