import type { NextApiRequest, NextApiResponse } from 'next';
import { EMBED_CHAT_PATH } from '@client/app/utils/embedSnippet';

/**
 * GET /api/embed/widget - the embeddable-chat loader script, referenced by the
 * customer's script-tag snippet (see app/utils/embedSnippet.ts). Runs on the
 * CUSTOMER's page, so unlike publish/widget it derives the app origin from its
 * own script src (window.location.origin would be the customer site), reads
 * config from its own tag's data attributes (there is no server-injected mount
 * node here), and injects a floating launcher that toggles an iframe onto the
 * /embed/chat widget page. The iframe is deliberately unsandboxed: the served
 * page needs same-origin fetch to mint/stream, and the real framing gate is
 * that page's frame-ancestors CSP, not an iframe attribute the embedding site
 * controls anyway.
 *
 * Same posture as publish/widget.ts: self-contained vanilla JS, DOM via
 * createElement/textContent. Its one network call is a cross-origin GET to the
 * app's /api/embed/branding (this script runs on the customer's page) to theme
 * the launcher per key; the launcher mounts with safe defaults first and only
 * re-themes if that resolves, so branding is purely additive and never blocks
 * or regresses the default bubble.
 */

const WIDGET_JS = String.raw`(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || !script.getAttribute) {
    script = document.querySelector('script[data-key][src*="/api/embed/widget"]');
  }
  if (!script) return;
  if (window.__b4mEmbedMounted || document.getElementById('b4m-embed-root')) return;

  var key = script.getAttribute('data-key');
  if (!key) {
    console.warn('[b4m-embed] missing data-key; widget not mounted');
    return;
  }
  var origin;
  try {
    origin = new URL(script.src).origin;
  } catch (e) {
    console.warn('[b4m-embed] could not resolve widget origin; widget not mounted');
    return;
  }
  window.__b4mEmbedMounted = true;

  var position = script.getAttribute('data-position') === 'bottom-left' ? 'left' : 'right';
  var iframeSrc = origin + '${EMBED_CHAT_PATH}' + '?k=' + encodeURIComponent(key);

  var css = document.createElement('style');
  css.textContent = [
    '#b4m-embed-root{position:fixed;z-index:2147483000;bottom:20px;' + position + ':20px;font-family:system-ui,-apple-system,sans-serif}',
    '#b4m-embed-launch{background:#1a1a2e;color:#fff;border:0;border-radius:999px;padding:12px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.28)}',
    '#b4m-embed-launch:hover{background:#2a2a44}',
    '#b4m-embed-panel{position:fixed;bottom:76px;' + position + ':20px;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 100px);display:none;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.32);overflow:hidden;background:#fff}',
    '#b4m-embed-panel.b4m-open{display:block}',
    '#b4m-embed-frame{width:100%;height:100%;border:0}'
  ].join('');

  var root = document.createElement('div');
  root.id = 'b4m-embed-root';

  var panel = document.createElement('div');
  panel.id = 'b4m-embed-panel';

  var frame = null;
  var brandedTitle = null;
  var launch = document.createElement('button');
  launch.id = 'b4m-embed-launch';
  launch.type = 'button';
  launch.textContent = 'Chat';
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.setAttribute('aria-expanded', 'false');

  launch.addEventListener('click', function () {
    var open = panel.className.indexOf('b4m-open') !== -1;
    if (open) {
      panel.className = '';
      launch.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'b4m-embed-frame';
      frame.src = iframeSrc;
      frame.title = brandedTitle || 'Chat';
      frame.loading = 'lazy';
      panel.appendChild(frame);
    }
    panel.className = 'b4m-open';
    launch.setAttribute('aria-expanded', 'true');
  });

  root.appendChild(panel);
  root.appendChild(launch);
  document.head.appendChild(css);
  document.body.appendChild(root);

  // Re-theme the launcher from the key's branding. Defaults are already mounted
  // above and are never mutated, so a slow/failed/absent fetch simply leaves the
  // default bubble - branding is strictly additive (no visual regression).
  function applyBranding(b) {
    if (!b || typeof b !== 'object') return;
    var color = typeof b.primaryColor === 'string' ? b.primaryColor.trim() : '';
    // Re-validate at the CSS sink; never trust a network value even though the
    // endpoint sanitizes. The char class alone makes ';', '}', 'url(' and
    // whitespace structurally impossible, so no escaping is needed on interpolation.
    // must stay in sync with EMBED_BRANDING_COLOR_PATTERN in @bike4mind/common
    if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) {
      var override = document.createElement('style');
      // Appended after the default style: equal specificity, later source order
      // wins, and filter:brightness keeps the hover a lighten of the base with no
      // color math (matching the default #1a1a2e -> #2a2a44 direction).
      override.textContent =
        '#b4m-embed-launch{background:' + color + '}' +
        '#b4m-embed-launch:hover{background:' + color + ';filter:brightness(1.1)}';
      document.head.appendChild(override);
    }
    var name = typeof b.displayName === 'string' ? b.displayName.trim().slice(0, 64) : '';
    if (name) {
      launch.setAttribute('aria-label', name);
      launch.setAttribute('title', name);
      brandedTitle = name;
    }
  }

  if (typeof fetch === 'function') {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
    var clearTimer = function () { if (timer) clearTimeout(timer); };
    fetch(origin + '/api/embed/branding?k=' + encodeURIComponent(key), ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        return r && r.ok ? r.json() : null;
      })
      .then(function (b) {
        clearTimer();
        if (b) applyBranding(b);
      })
      .catch(function () {
        clearTimer(); // keep the default styling
      });
  }
})();`;

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).end();
    return;
  }
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(WIDGET_JS);
}
