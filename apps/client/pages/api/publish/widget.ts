import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * GET /api/publish/widget - the trusted comment-overlay widget, served as
 * first-party JavaScript from the app origin so the bundle CSP (`script-src
 * 'self'`) permits it. Injected into every served bundle by the serve handler.
 *
 * This is the ONLY author-facing JS that runs on a published bundle page -
 * author inline scripts are stripped at serve time. The widget therefore must
 * be self-contained vanilla JS (no framework), build its DOM with
 * createElement/textContent (NEVER innerHTML on user data - comment bodies are
 * untrusted user input rendered on the app origin), and read the viewer's B4M
 * token from localStorage to authenticate writes.
 *
 * Config (publicId, commentPolicy) is read from the #b4m-annotate-root mount
 * node's data-* attributes; the widget talks to /api/publish/annotations/*.
 */

// Brand attribution for the widget footer, externalized for open-core: no brand
// fallback. Empty when APP_NAME is unset, in which case the footer shows only "Publish yours".
const WIDGET_POWERED_BY = process.env.APP_NAME ? `Powered by ${process.env.APP_NAME} — ` : '';

const WIDGET_JS = String.raw`(function () {
  'use strict';
  var root = document.getElementById('b4m-annotate-root');
  if (!root) return;
  var publicId = root.getAttribute('data-public-id');
  if (!publicId) return;
  var policy = root.getAttribute('data-comment-policy') || 'none';
  var origin = window.location.origin;
  var API = origin + '/api/publish/annotations/' + encodeURIComponent(publicId);

  // justPosted holds EVERY comment of ours the server list has not caught up to yet,
  // as [{id, at}] - a single slot would leave an earlier comment unprotected as soon
  // as a second one was posted, and the next stale poll would drop it. Entries expire
  // after PENDING_TTL_MS so a comment deleted before it ever appeared in the list
  // cannot be resurrected indefinitely. Must stay well above the poll cadence (60s
  // closed / 15s open) and the list's cache staleness, or a comment would be dropped
  // while it is still legitimately waiting to show up.
  var PENDING_TTL_MS = 300000;
  var state = { comments: [], canComment: false, open: false, pinMode: false, pendingAnchor: null, draft: '', justPosted: [] };

  function getToken() {
    try {
      var raw = localStorage.getItem('access-token-storage');
      if (!raw) return null;
      var p = JSON.parse(raw);
      return (p && p.state && p.state.accessToken) || null;
    } catch (e) { return null; }
  }
  function headers(json) {
    var h = {};
    if (json) h['Content-Type'] = 'application/json';
    var t = getToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  // Server clock minus client clock, learned from the initial list response's Date
  // header. Timestamps come from the server but were being compared against the
  // browser's clock, so a viewer whose clock ran behind saw every comment as "just
  // now". Only the FIRST load is sampled: it is sent no-store, so its Date header is
  // genuinely fresh, whereas a cached response's Date is older by its cache age.
  var serverSkewMs = 0;
  function noteServerClock(r) {
    try {
      var d = r.headers && r.headers.get && r.headers.get('date');
      if (!d) return;
      var t = new Date(d).getTime();
      if (!isNaN(t)) serverSkewMs = t - Date.now();
    } catch (e) { /* header unreadable - leave the skew at 0 */ }
  }
  function timeAgo(iso) {
    var s = Math.max(0, (Date.now() + serverSkewMs - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---- styles (style-src allows 'unsafe-inline') ----
  var css = document.createElement('style');
  css.textContent = [
    '#b4m-ov,#b4m-ov *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif}',
    // --b4m-chrome is the height of the wrapper's bottom livery bar (.b4m-bar), measured at
    // boot. That bar is fixed at z-index 2147483647 (the max), so we cannot stack above it -
    // the launcher and panel must sit clear of it instead. Must stay in sync with the bar in
    // renderBundleWrapper (pages/api/publish/serve/[...path].ts).
    '#b4m-ov{position:fixed;z-index:2147483000;bottom:calc(20px + var(--b4m-chrome,0px));right:20px}',
    '#b4m-launch{display:flex;align-items:center;gap:8px;background:#1a1a2e;color:#fff;border:0;border-radius:999px;padding:11px 16px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.28)}',
    '#b4m-launch:hover{background:#2a2a44}',
    '#b4m-launch .dot{background:#8ab4ff;color:#0f0f1a;border-radius:999px;min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;padding:0 5px}',
    '#b4m-panel{position:fixed;z-index:2147483000;bottom:calc(20px + var(--b4m-chrome,0px));right:20px;width:360px;max-width:calc(100vw - 32px);max-height:min(640px,calc(100vh - 40px - var(--b4m-chrome,0px)));background:#fff;color:#1a1a2e;border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.32);display:none;flex-direction:column;overflow:hidden}',
    '#b4m-panel.b4m-open{display:flex}',
    '#b4m-head{display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border-bottom:1px solid #ececf3}',
    '#b4m-head b{font-size:15px}',
    '#b4m-close{background:0;border:0;font-size:20px;line-height:1;cursor:pointer;color:#8a8aa0;padding:0 4px}',
    '#b4m-list{flex:1;overflow-y:auto;padding:6px 0}',
    '.b4m-c{padding:10px 15px;border-bottom:1px solid #f4f4f8}',
    '.b4m-c .who{font-size:13px;font-weight:600}',
    '.b4m-c .when{font-size:11px;color:#9a9ab0;margin-left:6px;font-weight:400}',
    '.b4m-c .body{font-size:13px;line-height:1.45;margin-top:3px;white-space:pre-wrap;word-wrap:break-word}',
    '.b4m-c .pin{font-size:11px;color:#5566cc;cursor:pointer;margin-top:3px;display:inline-block}',
    '.b4m-empty{padding:24px 16px;text-align:center;color:#9a9ab0;font-size:13px}',
    '#b4m-compose{border-top:1px solid #ececf3;padding:10px 12px}',
    '#b4m-ta{width:100%;border:1px solid #d8d8e4;border-radius:8px;padding:8px;font-size:13px;resize:vertical;min-height:54px;font-family:inherit}',
    '#b4m-actions{display:flex;align-items:center;gap:8px;margin-top:8px}',
    '#b4m-send{background:#3949d4;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer}',
    '#b4m-send:disabled{opacity:.5;cursor:default}',
    '#b4m-pintog{background:#eef0fb;color:#3949d4;border:0;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:600;cursor:pointer}',
    '#b4m-pintog.on{background:#3949d4;color:#fff}',
    '#b4m-signin{margin:10px 12px;padding:10px;background:#f4f4fb;border-radius:10px;text-align:center;font-size:13px}',
    '#b4m-signin a{color:#3949d4;font-weight:600;text-decoration:none}',
    '#b4m-foot{padding:9px 12px;border-top:1px solid #ececf3;text-align:center;font-size:11px;color:#9a9ab0}',
    '#b4m-foot a{color:#3949d4;text-decoration:none;font-weight:600}',
    '#b4m-hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:8px 16px;border-radius:999px;font-size:13px;z-index:2147483600;box-shadow:0 6px 24px rgba(0,0,0,.3)}'
  ].join('\n');
  document.head.appendChild(css);

  // ---- pin bridge: the artifact runs in a sandboxed iframe, so pin markers + the
  // pin-drop click live INSIDE it. We exchange UI messages with the in-iframe bridge
  // (injected at serve time) instead of handling clicks on this wrapper document. ----
  var frame = document.querySelector('iframe');
  // In Approach B the bundle is a TRUE cross-origin frame ({publicId}.usercontent.app.<domain>),
  // so pin its origin from frame.src and use it as the postMessage targetOrigin + an inbound
  // origin allowlist. In the same-origin srcdoc fallback (Approach A) frame.src is empty →
  // FO stays '*' (must target the opaque origin) and the inbound origin check is skipped.
  var FO = (function () { try { return frame && frame.src ? new URL(frame.src).origin : '*'; } catch (e) { return '*'; } })();
  function toFrame(m) {
    if (frame && frame.contentWindow) { try { frame.contentWindow.postMessage(m, FO); } catch (e) {} }
  }
  function pinList() {
    // GEOMETRY ONLY. The bundle in the iframe runs untrusted author JS, which can read
    // anything we postMessage in — so we never send comment text or author names there
    // (that would let a malicious bundle harvest commenters). The author/body live only
    // in the trusted parent panel; clicking a marker posts pin-activate → we open it here.
    var arr = state.comments
      .filter(function (c) { return c.anchor && typeof c.anchor.x === 'number' && typeof c.anchor.y === 'number'; })
      .map(function (c) { return { id: c.id, x: c.anchor.x, y: c.anchor.y }; });
    if (state.pendingAnchor) arr.push({ id: '__pending', x: state.pendingAnchor.x, y: state.pendingAnchor.y, pending: true });
    return arr;
  }
  function sendPins() { toFrame({ b4m: 'pins', pins: pinList() }); }

  // ---- panel ----
  var ov = document.createElement('div');
  ov.id = 'b4m-ov';
  var launch = document.createElement('button');
  launch.id = 'b4m-launch';
  launch.addEventListener('click', openPanel);
  ov.appendChild(launch);

  var panel = document.createElement('div');
  panel.id = 'b4m-panel';
  document.body.appendChild(ov);
  document.body.appendChild(panel);

  // The bottom livery bar is present only on own-tab open-public renders, and its height
  // grows when its contents wrap on narrow viewports - so measure rather than hardcode 52px.
  function syncChrome() {
    var bar = document.querySelector('.b4m-bar');
    var h = bar ? bar.getBoundingClientRect().height : 0;
    document.documentElement.style.setProperty('--b4m-chrome', h + 'px');
  }
  syncChrome();
  window.addEventListener('resize', syncChrome);

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function updateLaunch() {
    launch.textContent = '';
    launch.appendChild(document.createTextNode('Comments'));
    var d = el('span', 'dot', String(state.comments.length));
    launch.appendChild(d);
  }

  function openPanel() { state.open = true; render(); }
  function closePanel() { state.open = false; panel.classList.remove('b4m-open'); ov.style.display = ''; }

  function render() {
    updateLaunch();
    sendPins();
    if (!state.open) { panel.classList.remove('b4m-open'); ov.style.display = ''; return; }
    ov.style.display = 'none';
    panel.classList.add('b4m-open');
    // A poll-driven re-render rebuilds the composer; capture focus + caret so typing
    // isn't interrupted when someone else's comment arrives mid-keystroke.
    var ae = document.activeElement;
    var wasTyping = !!(ae && ae.id === 'b4m-ta');
    var selStart = wasTyping ? ae.selectionStart : 0;
    var selEnd = wasTyping ? ae.selectionEnd : 0;
    var composerTa = null;
    panel.textContent = '';

    var head = el('div'); head.id = 'b4m-head';
    head.appendChild(el('b', null, 'Comments (' + state.comments.length + ')'));
    var x = el('button', null, '×'); x.id = 'b4m-close'; x.addEventListener('click', closePanel);
    head.appendChild(x);
    panel.appendChild(head);

    var list = el('div'); list.id = 'b4m-list';
    if (!state.comments.length) {
      list.appendChild(el('div', 'b4m-empty', 'No comments yet.'));
    } else {
      state.comments.forEach(function (c) {
        var row = el('div', 'b4m-c');
        var who = el('div');
        who.appendChild(el('span', 'who', c.authorDisplayName));
        who.appendChild(el('span', 'when', timeAgo(c.createdAt)));
        row.appendChild(who);
        row.appendChild(el('div', 'body', c.body));
        if (c.anchor && typeof c.anchor.x === 'number') {
          var pin = el('span', 'pin', '📍 pinned');
          pin.addEventListener('click', function () { toFrame({ b4m: 'scrollto', y: c.anchor.y }); });
          row.appendChild(pin);
        }
        list.appendChild(row);
      });
    }
    panel.appendChild(list);

    if (state.canComment) {
      var compose = el('div'); compose.id = 'b4m-compose';
      var ta = el('textarea'); ta.id = 'b4m-ta'; ta.placeholder = 'Add a comment…';
      // Persist the draft in state so a background poll re-render never wipes what
      // the user is typing.
      ta.value = state.draft;
      ta.addEventListener('input', function () { state.draft = ta.value; });
      composerTa = ta;
      compose.appendChild(ta);
      var actions = el('div'); actions.id = 'b4m-actions';
      var pintog = el('button', state.pinMode ? 'on' : null, state.pendingAnchor ? '📍 pin set' : '📍 drop a pin');
      pintog.id = 'b4m-pintog';
      pintog.addEventListener('click', function () { togglePinMode(); });
      var send = el('button', null, 'Comment'); send.id = 'b4m-send';
      send.addEventListener('click', function () {
        var body = ta.value.trim();
        if (!body) return;
        send.disabled = true;
        postComment(body, state.pendingAnchor).then(function () {
          ta.value = ''; state.draft = ''; state.pendingAnchor = null; state.pinMode = false;
          toFrame({ b4m: 'pinmode', on: false });
          render(); // clears the pending marker; the new comment's own pin now renders
        }).catch(function (e) { alert('Could not post comment: ' + (e && e.message || e)); })
          .finally(function () { send.disabled = false; });
      });
      actions.appendChild(pintog);
      actions.appendChild(send);
      compose.appendChild(actions);
      panel.appendChild(compose);
    } else if (policy !== 'none' && !getToken()) {
      var si = el('div'); si.id = 'b4m-signin';
      si.appendChild(document.createTextNode('Want to leave feedback? '));
      var a = el('a', null, 'Sign in to comment'); a.href = origin + '/login'; si.appendChild(a);
      panel.appendChild(si);
    }

    var foot = el('div'); foot.id = 'b4m-foot';
    foot.appendChild(document.createTextNode(${JSON.stringify(WIDGET_POWERED_BY)}));
    var pub = el('a', null, 'Publish yours'); pub.href = origin + '/'; pub.target = '_blank'; pub.rel = 'noopener';
    foot.appendChild(pub);
    panel.appendChild(foot);

    // Restore focus + caret if the user was mid-comment when this re-render fired.
    if (wasTyping && composerTa) {
      composerTa.focus();
      try { composerTa.setSelectionRange(selStart, selEnd); } catch (e) {}
    }
  }

  function togglePinMode() {
    state.pinMode = !state.pinMode;
    if (!state.pinMode) state.pendingAnchor = null;
    toFrame({ b4m: 'pinmode', on: state.pinMode });
    showHint(state.pinMode ? 'Click anywhere on the artifact to drop a pin' : null);
    render();
  }

  var hintEl = null;
  function showHint(text) {
    if (hintEl) { hintEl.remove(); hintEl = null; }
    if (!text) return;
    hintEl = el('div', null, text); hintEl.id = 'b4m-hint';
    document.body.appendChild(hintEl);
  }

  // Messages from the in-iframe pin bridge. e.source === frame.contentWindow proves it's
  // OUR iframe; e.origin === FO pins it to the artifact's isolated origin (Approach B) and
  // is skipped only for the opaque-origin srcdoc fallback (FO === '*'). That frame still runs
  // untrusted author JS — so treat the payload as untrusted: validate types, and never act on
  // coords unless the user is in pin mode.
  window.addEventListener('message', function (e) {
    if (!frame || e.source !== frame.contentWindow) return;
    if (FO !== '*' && e.origin !== FO) return;
    var d = e.data || {};
    if (d.b4m === 'ready') {
      // Bridge (re)loaded — resend full UI state so a fresh bridge instance isn't left
      // out of sync (it boots with pinMode=false even if the user had it on).
      sendPins();
      toFrame({ b4m: 'pinmode', on: state.pinMode });
    } else if (d.b4m === 'pin-dropped') {
      if (!state.pinMode) return;
      if (typeof d.x !== 'number' || typeof d.y !== 'number' || !isFinite(d.x) || !isFinite(d.y)) return;
      state.pendingAnchor = { x: Math.max(0, Math.min(1, d.x)), y: Math.max(0, Math.min(1, d.y)) };
      state.pinMode = false;
      state.open = true;
      showHint(null);
      render();
    } else if (d.b4m === 'pin-activate') {
      openPanel();
    }
  });

  // ---- data ----
  // The comment LIST is shared across viewers (CDN-cacheable); per-viewer
  // can-comment is a SEPARATE no-store fetch so it never pollutes the cached
  // list. The list is polled; can-comment is fetched on load + tab-refocus only.
  var CAN_API = API + '/can-comment';

  function loadList() {
    // no-store on the INITIAL load only: the list is deliberately cacheable for the
    // polling fan-out, but a reader who just posted (or reloaded right after someone
    // else did) would otherwise be served their own stale pre-comment copy. The
    // in-memory justPosted guard below cannot help here - a reload wipes it.
    // Polls keep the default cache mode, so the fan-out collapse is preserved.
    return fetch(API, { headers: headers(false), credentials: 'omit', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); noteServerClock(r); return r.json(); })
      .then(function (data) {
        state.comments = data.annotations || [];
        policy = data.commentPolicy || policy;
        render();
      })
      .catch(function () { /* artifact may be private to this viewer; stay quiet */ render(); });
  }

  function loadCanComment() {
    fetch(CAN_API, { headers: headers(false), credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        if (data.commentPolicy) policy = data.commentPolicy;
        var next = !!data.canComment;
        if (next === state.canComment && lastCanComment !== null) return; // unchanged
        state.canComment = next;
        lastCanComment = next;
        render();
      })
      .catch(function () {});
  }

  function load() { loadList(); loadCanComment(); }

  function postComment(body, anchor) {
    var payload = { body: body };
    if (anchor) payload.anchor = anchor;
    return fetch(API, { method: 'POST', headers: headers(true), credentials: 'omit', body: JSON.stringify(payload) })
      .then(function (r) {
        if (r.status === 401) throw new Error('Please sign in again');
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ('HTTP ' + r.status)); });
        return r.json();
      })
      .then(function (created) {
        state.comments.push(created);
        state.justPosted.push({ id: created.id, at: Date.now() });
        render();
      });
  }

  // ---- smart polling: pick up other users' comments without a reload ----
  // Visibility-gated (a hidden tab polls nothing), self-scheduling so the cadence
  // can differ when the panel is open (15s, you're reading) vs closed (45s, just
  // keeping the launcher badge fresh). Re-renders only when the comment set
  // actually changed, and the draft + pending pin survive the re-render (above).
  function sig(list) {
    return list.length + ':' + list.map(function (c) { return c.id + (c.resolvedAt ? 'R' : ''); }).join(',');
  }
  var lastCanComment = null;
  function poll() {
    if (document.visibilityState !== 'visible') return;
    // Polls hit the cacheable LIST endpoint only (no per-viewer data) so the CDN
    // can collapse the fan-out across viewers.
    fetch(API, { headers: headers(false), credentials: 'omit' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        var incoming = data.annotations || [];
        // Don't let a poll whose fetch predated your just-posted comments drop them
        // from the list (it self-heals next cycle, but the blink is avoidable). Keep
        // the local copies until the server's list reflects them. Only protects YOUR
        // fresh posts — never resurrects others' deletes.
        if (state.justPosted.length) {
          var now = Date.now();
          // Retire an entry once the server list carries it, or once it ages out.
          state.justPosted = state.justPosted.filter(function (p) {
            return now - p.at < PENDING_TTL_MS && !incoming.some(function (c) { return c.id === p.id; });
          });
          var pending = state.comments.filter(function (c) {
            return state.justPosted.some(function (p) { return p.id === c.id; });
          });
          if (pending.length) incoming = incoming.concat(pending);
        }
        // Compare against what is actually on screen rather than a remembered
        // signature: an optimistic local copy can diverge from the last server
        // response, and a remembered signature would then early-return forever and
        // never reconcile it away.
        if (sig(incoming) === sig(state.comments)) return; // nothing changed
        state.comments = incoming;
        render();
      })
      .catch(function () {});
  }
  var pollTimer = null;
  function loop() {
    if (pollTimer) clearTimeout(pollTimer);
    // Snappy when actively commenting; slower for passive readers / closed panel to
    // bound origin load on a widely-viewed public artifact.
    var ms = state.open ? (state.canComment ? 15000 : 30000) : 60000;
    pollTimer = setTimeout(function () { poll(); loop(); }, ms);
  }
  // Catch up immediately when the tab regains focus (covers long-hidden tabs) —
  // refresh both the list and the viewer's comment capability (policy/sign-in may
  // have changed while away).
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    poll();
    loadCanComment();
  });

  updateLaunch();
  load();
  loop();
})();
`;

export default function handler(req: NextApiRequest, res: NextApiResponse): void {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.status(200).send(WIDGET_JS);
}
