/**
 * The self-contained HTML document served by pages/api/embed/serve.ts and framed
 * by customer sites. Vanilla JS only (no React, no build step), same posture as
 * pages/api/publish/widget.ts: DOM via createElement/textContent, never innerHTML
 * on untrusted content.
 *
 * FOOTGUN: never write a literal closing script tag inside the template strings
 * below - it would terminate the inline <script> early. Config crosses the
 * boundary only through serializeConfigForScript, which escapes `<`.
 */

/** Baked-in boot config for the widget page. The embed key is a publishable-class
 *  credential already present in the customer's page source (iframe src / script
 *  data-attr), so embedding it here leaks nothing new. */
export interface EmbedWidgetConfig {
  embedKey: string;
  agentId?: string;
  /** Non-secret key id, exposed for support correlation only. */
  keyId?: string;
  /** Header title; travels inside the JSON blob and is rendered via textContent. */
  displayName?: string;
  /** Relative so the calls stay same-origin behind CloudFront. */
  sessionPath?: string;
  chatPath?: string;
  poweredByLabel?: string;
}

/**
 * JSON-serialize config for embedding inside a <script> block. Escaping `<`
 * neutralizes script-terminator and comment-open breakouts; U+2028/U+2029 are
 * legal JSON but illegal in a JS string literal context, so escape them too.
 */
export function serializeConfigForScript(config: EmbedWidgetConfig): string {
  return JSON.stringify(config)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const DEFAULT_SESSION_PATH = '/api/embed/session';
const DEFAULT_CHAT_PATH = '/api/embed/chat';

export function renderEmbedWidgetHtml(config: EmbedWidgetConfig): string {
  const resolved: EmbedWidgetConfig = {
    sessionPath: DEFAULT_SESSION_PATH,
    chatPath: DEFAULT_CHAT_PATH,
    ...config,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Chat</title>
<style>
  html, body { height: 100%; margin: 0; }
  body { font-family: system-ui, -apple-system, sans-serif; }
</style>
</head>
<body>
<div id="b4m-embed-app"></div>
<script>window.__B4M_EMBED__ = ${serializeConfigForScript(resolved)};</script>
</body>
</html>
`;
}
