import { EMBED_SSE_PARSER_SRC } from './embedSseParser';

/**
 * The self-contained HTML document served by pages/api/embed/serve.ts and framed
 * by customer sites. Vanilla JS only (no React, no build step), same posture as
 * pages/api/publish/widget.ts: DOM text via textContent, never innerHTML on
 * untrusted content (user input and LLM output are both untrusted here).
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

/** Client-side history bounds: the chat route caps request bodies at 1mb
 *  (express.json), so trim resent history well under it and cap turn count. */
const WIDGET_CSS = `
  html, body { height: 100%; margin: 0; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    display: flex; flex-direction: column;
    background: #fff; color: #1a1a1a;
    font-size: 14px;
  }
  #b4m-header {
    padding: 10px 14px; font-weight: 600; border-bottom: 1px solid #e5e5e5;
    flex: 0 0 auto;
  }
  #b4m-transcript {
    flex: 1 1 auto; overflow-y: auto; padding: 12px 14px;
    display: flex; flex-direction: column; gap: 8px;
  }
  .b4m-msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; word-break: break-word; }
  .b4m-msg-user { align-self: flex-end; background: #2b6cb0; color: #fff; border-bottom-right-radius: 4px; }
  .b4m-msg-assistant { align-self: flex-start; background: #f1f1f1; border-bottom-left-radius: 4px; }
  .b4m-msg-error { align-self: flex-start; background: #fdecea; color: #922; }
  .b4m-note { align-self: flex-start; color: #888; font-size: 12px; }
  #b4m-composer { display: flex; gap: 8px; padding: 10px 14px; border-top: 1px solid #e5e5e5; flex: 0 0 auto; }
  #b4m-input {
    flex: 1 1 auto; resize: none; padding: 8px 10px; border: 1px solid #ccc; border-radius: 8px;
    font: inherit; min-height: 20px; max-height: 96px;
  }
  #b4m-send {
    flex: 0 0 auto; border: 0; border-radius: 8px; padding: 8px 14px;
    background: #2b6cb0; color: #fff; font: inherit; cursor: pointer;
  }
  #b4m-send:disabled { opacity: 0.5; cursor: default; }
  #b4m-footer { text-align: center; color: #999; font-size: 11px; padding: 4px 0 8px; flex: 0 0 auto; }
`;

const WIDGET_JS = `(function () {
  'use strict';
  ${EMBED_SSE_PARSER_SRC}

  var cfg = window.__B4M_EMBED__ || {};
  var history = [];
  var sessionToken = null;
  var busy = false;

  var HISTORY_MAX_TURNS = 40;
  var HISTORY_MAX_BYTES = 900000;

  var headerEl = document.getElementById('b4m-header');
  var transcriptEl = document.getElementById('b4m-transcript');
  var inputEl = document.getElementById('b4m-input');
  var sendEl = document.getElementById('b4m-send');
  var footerEl = document.getElementById('b4m-footer');

  headerEl.textContent = typeof cfg.displayName === 'string' && cfg.displayName ? cfg.displayName : 'Chat';
  if (typeof cfg.poweredByLabel === 'string' && cfg.poweredByLabel) {
    footerEl.textContent = cfg.poweredByLabel;
  }

  function addBubble(cls, text) {
    var node = document.createElement('div');
    node.className = 'b4m-msg ' + cls;
    node.textContent = text;
    transcriptEl.appendChild(node);
    scrollToBottom();
    return node;
  }

  function addNote(text) {
    var node = document.createElement('div');
    node.className = 'b4m-note';
    node.textContent = text;
    transcriptEl.appendChild(node);
    scrollToBottom();
  }

  function scrollToBottom() {
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function setBusy(b) {
    busy = b;
    inputEl.disabled = b;
    sendEl.disabled = b;
    if (!b) inputEl.focus();
  }

  function mintSession() {
    return fetch(cfg.sessionPath, {
      method: 'POST',
      headers: { 'X-API-Key': cfg.embedKey },
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('mint failed');
        err.status = res.status;
        throw err;
      }
      return res.json();
    }).then(function (data) {
      sessionToken = data.session_token;
    });
  }

  // The server resends nothing (stateless), so the full history goes up each
  // turn; keep it bounded under the route's 1mb body cap with headroom.
  function trimHistory() {
    while (history.length > HISTORY_MAX_TURNS) history.shift();
    while (history.length > 1 && JSON.stringify(history).length > HISTORY_MAX_BYTES) history.shift();
    if (history.length && history[0].role === 'assistant') history.shift();
  }

  function errorTextFor(status) {
    if (status === 403) return 'This chat is not available here.';
    if (status === 422) return 'The assistant is temporarily unavailable.';
    if (status === 429) return 'Too many messages right now - please wait a moment and try again.';
    return 'Could not send your message. Please try again.';
  }

  function streamChat(retried) {
    var ensure = sessionToken ? Promise.resolve() : mintSession();
    return ensure.then(function () {
      var body = { messages: history };
      if (cfg.agentId) body.agentId = cfg.agentId;
      return fetch(cfg.chatPath, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + sessionToken
        },
        credentials: 'omit',
        body: JSON.stringify(body)
      });
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        // Session tokens are short-lived; expiry is always a pre-stream 401.
        sessionToken = null;
        return streamChat(true);
      }
      if (!res.ok) {
        addBubble('b4m-msg-error', errorTextFor(res.status));
        return;
      }
      var contentType = res.headers.get('content-type') || '';
      if (contentType.indexOf('text/event-stream') === -1 || !res.body) {
        addBubble('b4m-msg-error', errorTextFor(0));
        return;
      }
      return readStream(res);
    }).catch(function (err) {
      addBubble('b4m-msg-error', errorTextFor(err && err.status ? err.status : 0));
    });
  }

  function readStream(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var bubble = null;
    var acc = '';
    var finished = false;

    function finalize(interrupted) {
      if (finished) return;
      finished = true;
      if (acc) {
        history.push({ role: 'assistant', content: acc });
        if (interrupted) addNote('Connection interrupted - the reply may be incomplete.');
      } else if (interrupted) {
        addBubble('b4m-msg-error', 'Connection interrupted. Please try again.');
      }
    }

    var parser = createSseParser({
      onContent: function (delta) {
        if (!delta) return;
        if (!bubble) bubble = addBubble('b4m-msg-assistant', '');
        acc += delta;
        bubble.textContent = acc;
        scrollToBottom();
      },
      onError: function () {
        finished = true;
        if (acc) history.push({ role: 'assistant', content: acc });
        addBubble('b4m-msg-error', 'The assistant hit an error. Please try again.');
      },
      onDone: function () {
        finalize(false);
      }
    });

    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          parser.flush();
          finalize(!parser.isDone());
          return;
        }
        parser.push(decoder.decode(step.value, { stream: true }));
        if (parser.isDone()) {
          // Frames after done/error are ignored by the parser; drain quietly.
          return reader.cancel().catch(function () {});
        }
        return pump();
      }).catch(function () {
        finalize(true);
      });
    }
    return pump();
  }

  function send() {
    if (busy) return;
    var text = inputEl.value.replace(/\\s+$/, '');
    if (!text.trim()) return;
    inputEl.value = '';
    history.push({ role: 'user', content: text });
    trimHistory();
    addBubble('b4m-msg-user', text);
    setBusy(true);
    streamChat(false).then(function () {
      setBusy(false);
    });
  }

  sendEl.addEventListener('click', send);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  inputEl.focus();
})();`;

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
<style>${WIDGET_CSS}</style>
</head>
<body>
<div id="b4m-header"></div>
<div id="b4m-transcript" role="log" aria-live="polite" aria-label="Conversation"></div>
<div id="b4m-composer">
<textarea id="b4m-input" rows="1" aria-label="Type a message" placeholder="Type a message"></textarea>
<button id="b4m-send" type="button">Send</button>
</div>
<div id="b4m-footer"></div>
<script>window.__B4M_EMBED__ = ${serializeConfigForScript(resolved)};</script>
<script>${WIDGET_JS}</script>
</body>
</html>
`;
}
