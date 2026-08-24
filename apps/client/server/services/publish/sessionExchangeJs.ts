/**
 * The browser-side session exchange, shared by every public shell the publish routes serve.
 *
 * A top-level navigation to `/p/...` carries no Authorization header, and there is no readable
 * credential in script storage: the access token is memory-only and the refresh token is an
 * HttpOnly cookie (app/hooks/useAccessToken.ts). So a shell that needs to act as the viewer has
 * to OBTAIN a token by exchanging the cookie, exactly as the app's own cold load does
 * (app/utils/sessionBootstrap.ts).
 *
 * This is the canonical home for that exchange, because the contract has already broken twice in
 * separate copies of the same logic: the loader shell and the comment widget each read a
 * localStorage field that #1346 had quietly made permanently undefined, and neither could notice
 * on its own.
 *
 * CAVEAT, so this does not read as more consolidated than it is: renderBundleLoaderShell still
 * carries its own inline copy, so today this has exactly ONE consumer (renderPassphraseShell).
 * Folding the loader shell in is a deliberate follow-up rather than part of this change - its
 * copy distinguishes "retries exhausted" from "no session" in the message it shows, which this
 * callback shape flattens, and reworking that belongs in its own reviewable change.
 *
 * Emits `b4mExchangeSession(cb)`: calls back with an access token, or null when the viewer has
 * no recoverable session. Never throws. Callers decide what a null means for them.
 */
export const SESSION_EXCHANGE_JS = `function b4mExchangeSession(cb) {
  var attempt = 0;
  function go() {
    attempt++;
    fetch('/api/auth/refreshToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: '{}'
    })
      .then(function (res) {
        // 401 is the ORDINARY answer for a signed-out viewer, so it settles immediately rather
        // than burning the backoff. Only a transient failure (cold Lambda 5xx) is retried.
        if (res.status === 200) return res.json();
        if (res.status === 401) { cb(null); return null; }
        if (attempt < 4) { setTimeout(go, attempt * 600); return null; }
        cb(null);
        return null;
      })
      .then(function (data) { if (data) cb(data.accessToken || null); })
      .catch(function () {
        if (attempt < 4) { setTimeout(go, attempt * 600); } else { cb(null); }
      });
  }
  go();
}`;
