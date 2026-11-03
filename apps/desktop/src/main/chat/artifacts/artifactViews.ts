import { randomUUID } from 'node:crypto';
import { ARTIFACT_SCHEME, SANDBOX_CSP } from './sandboxProtocol';

/** Where an artifact opened full-size in the agent's browser lives: `b4m-artifact://view/<token>`. */
const VIEW_HOST = 'view';

/** Artifacts kept open at once. Older ones answer with the not-found page, as an expired link would. */
export const MAX_ARTIFACT_VIEWS = 20;

/**
 * The inline frame's policy plus `sandbox allow-scripts`, which gives the top-level page the same
 * opaque origin the frame gets from its `sandbox` attribute: no storage shared between artifacts,
 * no popups, no modals. A header, so nothing in the artifact's own markup can loosen it.
 */
const VIEW_CSP = `${SANDBOX_CSP}; sandbox allow-scripts`;

const NOT_FOUND_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Artifact not available</title>
<style>body{font:14px system-ui,sans-serif;color:#555;margin:0;display:flex;align-items:center;justify-content:center;height:100vh}</style>
</head>
<body><p>This artifact is no longer open here. Open it again from its card in the conversation.</p></body>
</html>`;

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The artifact with a <title> the tab strip can show, unless it already has one. Placed after any
 * doctype, since markup ahead of the doctype would put the page in quirks mode.
 */
export function withTitle(content: string, title: string): string {
  if (/<title[\s>]/i.test(content)) return content;
  const tag = `<title>${escapeHtml(title.trim() || 'Artifact')}</title>`;
  const doctype = /^\s*<!doctype[^>]*>/i.exec(content);
  if (!doctype) return tag + content;
  const end = doctype.index + doctype[0].length;
  return content.slice(0, end) + tag + content.slice(end);
}

/**
 * HTML artifacts the user opened in a conversation's browser, by an unguessable token.
 *
 * Main-process memory only and never written anywhere: the token is the only way to the content,
 * and only main hands one out, to a navigation main starts itself (BrowserManager.openArtifact).
 */
export class ArtifactViewRegistry {
  private readonly views = new Map<string, string>();

  /** Keep `content` and return the url that serves it. */
  add(title: string, content: string): string {
    const token = randomUUID();
    this.views.set(token, withTitle(content, title));
    while (this.views.size > MAX_ARTIFACT_VIEWS) {
      const oldest = this.views.keys().next().value;
      if (oldest === undefined) break;
      this.views.delete(oldest);
    }
    return `${ARTIFACT_SCHEME}://${VIEW_HOST}/${token}`;
  }

  get(token: string): string | undefined {
    return this.views.get(token);
  }

  clear(): void {
    this.views.clear();
  }
}

/**
 * The response for any `b4m-artifact:` request made in the agent's browser partition.
 *
 * Only `view/<token>` for a token still held answers with content. Everything else, the inline
 * frame's `sandbox/` shell included, is the inert not-found page: that shell is served on the
 * app's default session for the renderer's frame (sandboxProtocol.ts) and has no use here.
 */
export function serveArtifactView(registry: ArtifactViewRegistry, requestUrl: string): Response {
  let content: string | undefined;
  try {
    const url = new URL(requestUrl);
    if (url.protocol === `${ARTIFACT_SCHEME}:` && url.host === VIEW_HOST) {
      content = registry.get(url.pathname.replace(/^\//, ''));
    }
  } catch {
    content = undefined;
  }
  return new Response(content ?? NOT_FOUND_HTML, {
    status: content === undefined ? 404 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': VIEW_CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
