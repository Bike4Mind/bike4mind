import type { ChatArtifact } from './chat';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The page the browser pane shows for an artifact. HTML is the page itself and an SVG draws as
 * one; every other type shows as its source, as the transcript card does for types it cannot run.
 * A wrapped page names itself, since an SVG's own <title> would otherwise pass for the page's.
 *
 * Shared so main rebuilds the same page when a reply updates an open artifact (BrowserManager).
 */
export function paneDocument(artifact: Pick<ChatArtifact, 'type' | 'title' | 'content'>): string {
  if (artifact.type === 'html') return artifact.content;
  const head = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(artifact.title.trim() || 'Artifact')}</title></head>`;
  if (artifact.type === 'svg') return `${head}<body style="margin:0">${artifact.content}</body></html>`;
  return (
    `${head}<body style="margin:0;padding:16px;font:13px/1.5 ui-monospace,Menlo,monospace">` +
    `<pre style="margin:0;white-space:pre-wrap">${escapeHtml(artifact.content)}</pre></body></html>`
  );
}
