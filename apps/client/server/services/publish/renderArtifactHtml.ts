import type { ArtifactType } from '@bike4mind/common';
import { buildShareFooterHtml } from '@client/app/utils/shareFooter';

/**
 * Server-authoritative renderer: turn a B4M artifact's RAW content into the canonical
 * published `index.html`. This is the single source of truth for artifact -> published
 * bytes; every publish surface (web client, MCP publish tool, CLI) can upload raw content
 * and let `finalize` render it here rather than re-implementing the wrapper and drifting.
 *
 * React is NOT handled here - it needs transpilation (see `buildReactArtifactBundle`) and
 * finalize routes it separately. Every other artifact type renders to a self-contained
 * static page: full HTML docs pass through with only the share footer injected; HTML
 * fragments and inline SVG are wrapped in a minimal page shell; all source-bearing types
 * (code/python/mermaid/recharts/json/...) render their source in a code view.
 *
 * MUST stay byte-identical to the web client's `buildArtifactIndexHtml`
 * (`apps/client/app/utils/publishApi.ts`) until #1492 removes the client copy - the
 * byte-parity tests in `renderArtifactHtml.test.ts` guard that invariant.
 */

/** Escapes &, <, >, ", ' for interpolation into HTML text/attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Render an artifact to a single static index.html based on its type. */
export function renderArtifactIndexHtml(type: ArtifactType, content: string, title: string): string {
  const t = escapeHtml(title || 'Shared artifact');
  // Full HTML doc -> serve as-is, but still inject the lead-gen footer before
  // </body> (fall back to appending) so every published page is branded.
  if (type === 'html' && /<html[\s>]/i.test(content)) {
    const footer = buildShareFooterHtml({ source: 'artifact' });
    return /<\/body>/i.test(content) ? content.replace(/<\/body>/i, `${footer}</body>`) : content + footer;
  }

  const PAGE = (inner: string, extraStyle = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="${t}"><title>${t}</title>
<style>:root{color-scheme:light dark}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;line-height:1.6;max-width:900px;margin:0 auto;padding:2rem 1.25rem 4rem}pre{background:rgba(127,127,127,.12);padding:1rem;border-radius:8px;overflow-x:auto;white-space:pre-wrap;word-wrap:break-word}img,svg{max-width:100%;height:auto}${extraStyle}</style>
</head><body>${inner}${buildShareFooterHtml({ source: 'artifact' })}</body></html>`;

  if (type === 'html') return PAGE(content); // HTML fragment
  if (type === 'svg') return PAGE(content); // inline SVG markup
  // Source-bearing types (code/python/react/recharts/mermaid/json/...) -> code view.
  return PAGE(`<pre><code>${escapeHtml(content)}</code></pre>`);
}
