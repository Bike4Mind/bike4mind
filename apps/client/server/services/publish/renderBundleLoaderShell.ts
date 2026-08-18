/**
 * Public bootstrap shell for a GATED bundle navigated WITHOUT a credential.
 *
 * A top-level browser navigation to `/p/...` carries no Authorization header, so the
 * serve route can't authorize a gated bundle on the initial GET. Instead of 401, it
 * returns this small PUBLIC page (no secret). Its inline bootstrap script - running on
 * the app origin, where the session lives - exchanges the HttpOnly refresh cookie for an
 * access token and re-fetches the SAME route with `?raw=1` + `Authorization: Bearer`,
 * then injects the returned srcdoc into the sandboxed iframe client-side.
 *
 * The credential is obtained by POSTing `/api/auth/refreshToken`, exactly as the app's own
 * cold-load path does (app/utils/sessionBootstrap.ts) - NOT by reading localStorage. The
 * access token is memory-only and the refresh token is an HttpOnly cookie, so a fresh
 * navigation to this shell has no readable credential anywhere in script storage; the shell
 * used to read one out of the zustand-persist envelope, which silently became `undefined` and
 * told every signed-in viewer of a gated artifact to sign in. The exchange is also deliberately
 * unconditional - WebKit ITP evicts script-writable storage after ~7 days while leaving the
 * server-set cookie intact, so no client-side flag can be trusted to mean "signed out".
 * MUST STAY IN SYNC with sessionBootstrap.ts: this shell is a second consumer of the browser
 * session transport and cannot notice on its own when that transport changes.
 *
 * The opaque-origin model is preserved: the bundle still runs in
 * `<iframe sandbox="allow-scripts">` with NO `allow-same-origin`, so it can't read the
 * app's localStorage/cookies. The token is held only by THIS trusted shell on the app
 * origin and sent only as a fetch header - it is never placed into the iframe or srcdoc.
 *
 * The shell is served with the SAME CSP as a real wrapped render, so the injected srcdoc
 * inherits the right policy. `script-src 'unsafe-inline'` permits this bootstrap script.
 * The page is FULLY STATIC - it contains no per-artifact data at all (no title, no id):
 * the artifact title would otherwise leak to an anonymous viewer of a gated bundle (the
 * pre-PR 401 disclosed nothing), so the shell shows a constant title and the real title
 * only appears once the authenticated `?raw=1` srcdoc renders. The login URL is built
 * from `location.*` at runtime. No server interpolation -> no injection surface.
 *
 * Carries `noindex` unconditionally: this shell is only ever returned for a GATED
 * artifact, so it is by definition not search-discoverable. It holds no artifact data,
 * so an indexed copy would leak nothing - but a gated artifact's URL still has no
 * business in a search index. Mirrors the header the serve route already sets.
 */
import { HASH_BRIDGE_JS } from './fragmentNav';

export function renderBundleLoaderShell(): string {
  // Bootstrap script: no server-interpolated values.
  const bootstrap = `(function () {
  var frame = document.getElementById('b4m-frame');
  var msg = document.getElementById('b4m-msg');
  function show(html) {
    if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    if (msg) { msg.innerHTML = html; msg.style.display = 'block'; }
  }
  function note(text) { if (msg) { msg.textContent = text; msg.style.display = 'block'; } }
  var loginUrl = '/login?redirectTo=' + encodeURIComponent(location.pathname + location.search);
  var signIn = 'Sign in to view this shared item. <a href="' + loginUrl + '">Sign in</a>';
  var expiredMsg = 'Your session has ended. <a href="' + loginUrl + '">Sign in again</a> to view this shared item.';
  var token = null;
  note('Loading...');

  // Stage 1: trade the HttpOnly refresh cookie for an access token. Unconditional - no
  // client-side precheck, for the reasons in this file's header and sessionBootstrap.ts.
  var authAttempt = 0;
  function authenticate() {
    authAttempt++;
    fetch('/api/auth/refreshToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}'
    })
      .then(function (res) {
        if (res.status === 200) return res.json();
        // 401 is the ORDINARY answer for a viewer with no session (anyone opening a private
        // link while signed out), so it resolves immediately rather than burning the backoff.
        // Only a transient failure - cold Lambda 5xx, rate limit - is worth retrying.
        if (res.status === 401) { show(signIn); return null; }
        if (authAttempt < 4) { setTimeout(authenticate, authAttempt * 600); return null; }
        show('This shared item could not be loaded.');
        return null;
      })
      .then(function (data) {
        if (!data || !data.accessToken) return;
        token = data.accessToken;
        load();
      })
      .catch(function () {
        if (authAttempt < 4) { setTimeout(authenticate, authAttempt * 600); }
        else { show('This shared item could not be loaded.'); }
      });
  }

  // Stage 2: re-fetch this same URL with the recovered credential and inject the result.
  var url = location.pathname + (location.search ? location.search + '&' : '?') + 'raw=1';
  var attempt = 0;
  function load() {
    attempt++;
    fetch(url, { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit' })
      .then(function (res) {
        if (res.status === 200) return res.text();
        // A freshly-deployed (cold) Lambda can miss JWT verification on its first hit and 401,
        // or 5xx transiently - retry a few times with backoff before treating it as terminal.
        if ((res.status === 401 || res.status >= 500) && attempt < 4) { setTimeout(load, attempt * 600); return null; }
        // The three terminal outcomes are deliberately distinct: a 401 here means the token we
        // just minted was rejected (session ended mid-flight), which needs a re-login, while a
        // 403 means the session is fine and simply lacks access to THIS artifact - telling that
        // viewer to sign in sends them round a loop that cannot help.
        if (res.status === 401) { show(expiredMsg); return null; }
        if (res.status === 403) { show('You do not have access to this shared item. Ask its owner to share it with you.'); return null; }
        show('This shared item could not be loaded.');
        return null;
      })
      .then(function (text) {
        if (text != null && frame) { frame.srcdoc = text; frame.style.display = 'block'; if (msg) msg.style.display = 'none'; }
      })
      .catch(function () { if (attempt < 4) { setTimeout(load, attempt * 600); } else { show('This shared item could not be loaded.'); } });
  }
  authenticate();
})();`;

  // SECURITY: `sandbox="allow-scripts"` WITHOUT `allow-same-origin` - identical to the
  // wrapped render. The bundle runs on an opaque origin; never add `allow-same-origin`.
  // The iframe starts hidden so a slow `?raw=1` round-trip shows "Loading..." instead of a
  // blank viewport; it's revealed once srcdoc is set. Title is a constant (see header).
  // brand is externalized: drop the brand clause when APP_NAME is unconfigured.
  const brand = process.env.APP_NAME || '';
  const sharedTitle = `Shared${brand ? ` from ${brand}` : ''}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${sharedTitle}</title>
<style>
  html,body{margin:0;padding:0;height:100%}
  iframe{border:0;display:block;width:100%;height:100vh}
  #b4m-msg{display:none;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
           max-width:540px;margin:18vh auto 0;padding:0 1.25rem;text-align:center;line-height:1.6;
           color:#1a1a2e}
  @media (prefers-color-scheme: dark){#b4m-msg{color:#e6e6f0}#b4m-msg a{color:#8ab4ff}}
</style>
</head>
<body>
<iframe id="b4m-frame" sandbox="allow-scripts" title="${sharedTitle}" style="display:none"></iframe>
<div id="b4m-msg"></div>
<noscript><div style="max-width:540px;margin:18vh auto 0;padding:0 1.25rem;text-align:center;font-family:system-ui,sans-serif">This is a private item. <a href="/login">Sign in</a> to view it.</div></noscript>
<script>${bootstrap}</script>
<script>${HASH_BRIDGE_JS}</script>
</body>
</html>`;
}
