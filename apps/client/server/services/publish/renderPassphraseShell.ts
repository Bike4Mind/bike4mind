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
 */
export function renderPassphraseShell(): string {
  const bootstrap = `(function () {
  var form = document.getElementById('b4m-pp-form');
  var input = document.getElementById('b4m-pp-input');
  var btn = document.getElementById('b4m-pp-btn');
  var msg = document.getElementById('b4m-pp-msg');
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
  input.focus();
})();`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
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
    <form id="b4m-pp-form">
      <input id="b4m-pp-input" type="password" autocomplete="off" aria-label="Passphrase">
      <button id="b4m-pp-btn" type="submit">Unlock</button>
    </form>
    <div id="b4m-pp-msg" role="status"></div>
  </div>
  <script>${bootstrap}</script>
</body>
</html>`;
}
