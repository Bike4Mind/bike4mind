/**
 * The embed snippet contract, shared by the loader route
 * (pages/api/embed/widget.ts), the snippet-generator UI, and docs - one source
 * of truth for the customer-facing paths and the two copy-paste snippets, so
 * the served code and the generated snippets cannot drift apart.
 *
 * Script-tag variant: `<script src="<host>/api/embed/widget" data-key data-position>`.
 * The loader (widget.ts) reads exactly `data-key` (required) and `data-position`
 * (`bottom-right` default | `bottom-left`); keep any new option in lockstep with
 * both `buildScriptSnippet` here and the loader's attribute reads.
 * Iframe variant: `<iframe src="<host>/embed/chat?k=<key>">` at a fixed size.
 */

import { escapeAttr } from './htmlEscape';

/** Pretty widget-page path (rewritten to /api/embed/serve; key rides `?k=`). */
export const EMBED_CHAT_PATH = '/embed/chat';
/** The script-tag loader that injects the floating chat bubble. */
export const EMBED_WIDGET_PATH = '/api/embed/widget';
/** Raw keys are shown once at mint time and are not recoverable afterwards;
 *  the generator emits this placeholder unless the user pastes their key. */
export const EMBED_KEY_PLACEHOLDER = 'YOUR_EMBED_KEY';

export type EmbedPosition = 'bottom-right' | 'bottom-left';

export interface EmbedSnippetParams {
  /** Full app origin, e.g. https://app.example.com (trailing slashes tolerated). */
  baseUrl: string;
  embedKey: string;
  /** Agent display name, used for the iframe's accessible title. */
  title?: string;
  position?: EmbedPosition;
  width?: string | number;
  height?: string | number;
}

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Floating-bubble variant: one script tag, config via data attributes. */
export function buildScriptSnippet(params: EmbedSnippetParams): string {
  const attrs = [
    `src="${escapeAttr(trimBase(params.baseUrl) + EMBED_WIDGET_PATH)}"`,
    `data-key="${escapeAttr(params.embedKey)}"`,
  ];
  if (params.position) attrs.push(`data-position="${escapeAttr(params.position)}"`);
  return `<script ${attrs.join(' ')} async></scr` + `ipt>`;
}

/** Inline variant: the widget page framed directly at a fixed size. */
export function buildIframeSnippet(params: EmbedSnippetParams): string {
  const src = `${trimBase(params.baseUrl)}${EMBED_CHAT_PATH}?k=${encodeURIComponent(params.embedKey)}`;
  const width = params.width ?? 400;
  const height = params.height ?? 600;
  const title = params.title ? `${params.title} chat` : 'Chat';
  return (
    `<iframe src="${escapeAttr(src)}" width="${escapeAttr(String(width))}" ` +
    `height="${escapeAttr(String(height))}" style="border:0" loading="lazy" ` +
    `title="${escapeAttr(title)}"></iframe>`
  );
}
