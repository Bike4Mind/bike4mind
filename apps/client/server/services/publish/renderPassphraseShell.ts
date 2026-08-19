/**
 * Public prompt shell for a PASSPHRASE-gated published artifact (issue #383).
 *
 * A navigation to `/p/...` with no valid proof cookie gets this small PUBLIC page
 * instead of a 401. Its inline script POSTs the entered passphrase (plus the
 * current pathname, from `location` at runtime) to /api/publish/gate/passphrase;
 * on success the server sets the HttpOnly proof cookie and the shell reloads the
 * page, which now passes the gate server-side.
 *
 * Like renderBundleLoaderShell, this page is FULLY STATIC - it carries no
 * per-artifact data (no title, no id), so an anonymous viewer learns nothing
 * about the artifact beyond "it exists and wants a passphrase". No server
 * interpolation -> no injection surface. The passphrase travels only in the
 * POST body over HTTPS and is never persisted client-side; the proof cookie
 * (not the passphrase) is what future requests carry.
 *
 * Framed render: when this shell lands inside an iframe (a sandboxed bundle
 * navigated to a gated path after its proof cookie was dropped/expired), the
 * form cannot function - the sandbox suppresses form submission and strips
 * credentials - so the script swaps it for open-in-own-tab guidance instead.
 *
 * OWNER BYPASS. checkAccessGate already lets the owner and an admin through their own gate
 * before it ever looks at the proof cookie - but that is guarded on `user?.id`, and a top-level
 * navigation carries no credential, so it could never fire and the owner was asked for the
 * passphrase they themselves set. This shell therefore exchanges the refresh cookie for an
 * access token and asks /api/publish/gate/owner to mint the proof cookie on identity alone; on
 * success it RELOADS, and the artifact comes back through the ordinary serve path. Minting and
 * reloading rather than rendering here is deliberate: this page's CSP is deliberately tight
 * because it holds a credential input, and a sandboxed srcdoc frame inherits its parent's
 * policy - so rendering in place would mean either loosening the policy that protects the
 * passphrase field or shipping a second copy of the viewer pipeline.
 *
 * The form is held back only for that one round trip (bounded by FORM_REVEAL_MS), so the common
 * case - someone who followed a link they were given - is never left waiting on a check that
 * cannot help them.
 */
import { SESSION_EXCHANGE_JS } from './sessionExchangeJs';

export function renderPassphraseShell(): string {
  const bootstrap = `(function () {
  var form = document.getElementById('b4m-pp-form');
  var input = document.getElementById('b4m-pp-input');
  var btn = document.getElementById('b4m-pp-btn');
  var msg = document.getElementById('b4m-pp-msg');
  var hint = document.getElementById('b4m-pp-hint');
  function note(text) { msg.textContent = text; }
  if (window.top !== window.self) {
    // Framed render (e.g. a sandboxed bundle iframe navigated here after its
    // proof cookie was dropped/expired): the form CANNOT work - the sandbox has
    // no allow-forms (the submit event is suppressed before it fires) and a
    // fetch from the opaque origin would be uncredentialed. Swap to guidance
    // instead of a dead-end form. textContent only - no injection surface.
    form.parentNode.removeChild(form);
    var p = document.getElementById('b4m-pp-hint');
    p.textContent = 'It cannot be unlocked inside an embedded view. Open this link in its own tab to enter the passphrase:';
    var url = document.createElement('code');
    url.id = 'b4m-pp-url';
    url.textContent = location.href;
    msg.parentNode.insertBefore(url, msg);
    return;
  }
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var passphrase = input.value;
    if (!passphrase) { note('Enter the passphrase.'); return; }
    btn.disabled = true;
    note('Checking...');
    fetch('/api/publish/gate/passphrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: location.pathname, passphrase: passphrase })
    })
      .then(function (res) {
        if (res.status === 204) { note('Unlocked - loading...'); location.reload(); return; }
        btn.disabled = false;
        if (res.status === 403) { note('That passphrase is not correct.'); return; }
        if (res.status === 423) {
          // Locked after too many wrong attempts. Keep the button disabled and
          // surface the wait from Retry-After (seconds) rather than let them hammer on.
          btn.disabled = true;
          var secs = parseInt(res.headers.get('Retry-After'), 10);
          var wait = (secs && secs > 60) ? (Math.ceil(secs / 60) + ' minutes') : 'a minute';
          note('Too many incorrect attempts. Try again in ' + wait + '.');
          return;
        }
        if (res.status === 429) { note('Too many attempts - wait a minute and try again.'); return; }
        note('Something went wrong - try again.');
      })
      .catch(function () { btn.disabled = false; note('Network error - try again.'); });
  });

  // ---- owner/admin bypass: try the session before asking for a passphrase ----
  // The form starts hidden and is revealed either when the check comes back unhelpful or when
  // FORM_REVEAL_MS elapses, whichever is first - a slow or failed exchange must never strand a
  // viewer in front of a spinner when a passphrase would have let them straight in.
  var FORM_REVEAL_MS = 1500;
  var settled = false;
  function revealForm() {
    if (settled) return;
    settled = true;
    form.style.visibility = 'visible';
    input.focus();
  }
  var revealTimer = setTimeout(revealForm, FORM_REVEAL_MS);

  // One-shot: a proof cookie that does not stick (blocked, or dropped between the 204 and the
  // reload) would otherwise re-serve this shell, mint again and reload again, bounded only by the
  // 60/min rate limit. The sentinel turns that cycle into exactly one attempt, degrading to the
  // form - the correct destination when the cookie mechanism is not working.
  var SENTINEL = 'b4m-pp-tried-' + location.pathname;
  var alreadyTried = false;
  try { alreadyTried = sessionStorage.getItem(SENTINEL) === '1'; } catch (e) {}
  if (alreadyTried) { revealForm(); return; }

  b4mExchangeSession(function (token) {
    if (!token) { revealForm(); return; }
    // Ask the server to mint the proof cookie on identity alone. It says yes only to the owner
    // and to an admin - exactly who checkAccessGate already admits ahead of any proof check.
    // On success we RELOAD rather than rendering here: the reload passes the gate server-side
    // and the artifact comes back through the ordinary serve path, with the ordinary wrapper
    // and CSP. Rendering in place would mean rebuilding the sandboxed-iframe pipeline inside a
    // page whose CSP is deliberately tight because it holds a credential input.
    try { sessionStorage.setItem(SENTINEL, '1'); } catch (e) {}
    fetch('/api/publish/gate/owner', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      credentials: 'include',
      body: JSON.stringify({ path: location.pathname })
    })
      .then(function (res) {
        if (res.status === 204) {
          // Reload UNCONDITIONALLY, even if the reveal timer already won the race. The cookie
          // is set server-side by this point, so returning early would abandon a gate the owner
          // has already passed and leave them staring at a prompt for a passphrase that is
          // deliberately unrecoverable. The revealed form holds no state worth preserving.
          // Reachable, not theoretical: the exchange's own ladder retries at 600ms and 1800ms,
          // so two transient failures put this response past the 1500ms budget by construction.
          settled = true;
          clearTimeout(revealTimer);
          if (hint) hint.textContent = 'Opening your artifact...';
          location.reload();
          return;
        }
        // 401/403/404 all mean "this viewer must supply the passphrase", which is every
        // viewer who is not the owner - the overwhelmingly common case for a shared link.
        revealForm();
      })
      .catch(function () { revealForm(); });
  });
})();`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>Passphrase required</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0f1216;color:#e6edf3;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
  .card{max-width:360px;width:calc(100% - 48px);padding:32px 28px;border:1px solid #2a3138;
        border-radius:12px;background:#161b22;text-align:center}
  .lock{font-size:28px;margin-bottom:10px}
  h1{font-size:17px;font-weight:600;margin:0 0 6px}
  p{font-size:13.5px;color:#8b98a5;margin:0 0 18px;line-height:1.5}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #2a3138;
        background:#0f1216;color:#e6edf3;font-size:14px;margin-bottom:12px}
  input:focus{outline:2px solid #4493f8;border-color:transparent}
  button{width:100%;padding:10px 12px;border-radius:8px;border:0;background:#1f6feb;color:#fff;
         font-size:14px;font-weight:600;cursor:pointer}
  button:disabled{opacity:.6;cursor:default}
  #b4m-pp-msg{font-size:12.5px;color:#8b98a5;min-height:18px;margin-top:12px}
  #b4m-pp-url{display:block;word-break:break-all;font-size:12px;text-align:left;color:#e6edf3;
              background:#0f1216;border:1px solid #2a3138;border-radius:8px;padding:10px 12px;user-select:all}
</style>
</head>
<body>
  <div class="card">
    <div class="lock" aria-hidden="true">&#128274;</div>
    <h1>This shared item is passphrase-protected</h1>
    <p id="b4m-pp-hint">Enter the passphrase you were given to view it.</p>
    <form id="b4m-pp-form" style="visibility:hidden">
      <input id="b4m-pp-input" type="password" autocomplete="off" aria-label="Passphrase">
      <button id="b4m-pp-btn" type="submit">Unlock</button>
    </form>
    <div id="b4m-pp-msg" role="status"></div>
  </div>
  <script>${SESSION_EXCHANGE_JS}</script>
  <script>${bootstrap}</script>
</body>
</html>`;
}
