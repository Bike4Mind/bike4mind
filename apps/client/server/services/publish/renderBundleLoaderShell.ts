/**
 * Public bootstrap shell for a GATED bundle navigated WITHOUT a credential.
 *
 * A top-level browser navigation to `/p/...` carries no Authorization header, so the
 * serve route can't authorize a gated bundle on the initial GET. Instead of 401, it
 * returns this small PUBLIC page (no secret). Its inline bootstrap script - running on
 * the app origin, where the JWT lives - reads the access token from localStorage and
 * re-fetches the SAME route with `?raw=1` + `Authorization: Bearer`, then injects the
 * returned srcdoc into the sandboxed iframe client-side.
 *
 * The opaque-origin model is preserved: the bundle still runs in
 * `<iframe sandbox="allow-scripts">` with NO `allow-same-origin`, so it can't read the
 * app's localStorage/cookies. The token is read only by THIS trusted shell on the app
 * origin and sent only as a fetch header - it is never placed into the iframe or srcdoc.
 *
 * The shell is served with the SAME CSP as a real wrapped render, so the injected srcdoc
 * inherits the right policy. `script-src 'unsafe-inline'` permits this bootstrap script.
 * The page is FULLY STATIC - it contains no per-artifact data at all (no title, no id):
 * the artifact title would otherwise leak to an anonymous viewer of a gated bundle (the
 * pre-PR 401 disclosed nothing), so the shell shows a constant title and the real title
 * only appears once the authenticated `?raw=1` srcdoc renders. The login URL is built
 * from `location.*` at runtime. No server interpolation -> no injection surface.
 */
export function renderBundleLoaderShell(): string {
  // Bootstrap script: no server-interpolated values. The localStorage key mirrors
  // ACCESS_TOKEN_STORAGE_KEY in app/hooks/useAccessToken.ts.
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
  var token = null, expired = true;
  try {
    var stored = localStorage.getItem('access-token-storage');
    // Fail safe: only treat the session as live when expired is EXPLICITLY false. A missing
    // expired field (corrupted / hand-edited storage) defaults to expired, so we never send a
    // token we can't vouch for (the server is authoritative regardless, but this avoids a
    // pointless 401 round-trip and keeps the client check conservative).
    if (stored) { var s = (JSON.parse(stored) || {}).state || {}; token = s.accessToken; expired = s.expired !== false; }
  } catch (e) {}
  if (!token || expired) { show(signIn); return; }
  note('Loading…');
  var url = location.pathname + (location.search ? location.search + '&' : '?') + 'raw=1';
  var attempt = 0;
  function load() {
    attempt++;
    fetch(url, { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit' })
      .then(function (res) {
        if (res.status === 200) return res.text();
        // A freshly-deployed (cold) Lambda can miss JWT verification on its first hit and 401,
        // or 5xx transiently — retry a few times with backoff before treating it as terminal.
        if ((res.status === 401 || res.status >= 500) && attempt < 4) { setTimeout(load, attempt * 600); return null; }
        if (res.status === 401) { show(signIn); return null; }
        if (res.status === 403) { show('You do not have access to this shared item.'); return null; }
        show('This shared item could not be loaded.');
        return null;
      })
      .then(function (text) {
        if (text != null && frame) { frame.srcdoc = text; frame.style.display = 'block'; if (msg) msg.style.display = 'none'; }
      })
      .catch(function () { if (attempt < 4) { setTimeout(load, attempt * 600); } else { show('This shared item could not be loaded.'); } });
  }
  load();
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
<noscript><div style="max-width:540px;margin:18vh auto 0;padding:0 1.25rem;text-align:center;font-family:system-ui,sans-serif">This shared item requires JavaScript to view. If you're signed in it will load automatically; otherwise <a href="/login">sign in</a>.</div></noscript>
<script>${bootstrap}</script>
</body>
</html>`;
}
