/**
 * The widget page's SSE frame parser, kept as a source string so the same code
 * both runs inside the served page (interpolated into the inline script by
 * embedWidgetPage.ts) and gets unit-tested in Node against the real
 * @bike4mind/common serializer (new Function in embedSseParser.test.ts).
 *
 * Parses the exact wire format emitted by the embed chat route: `\n\n`-separated
 * frames, `:`-prefixed keep-alive comments, `data: [DONE]`, and JSON events
 * with type meta | content | tool_use | error (see sseEvents.ts). tool_use is
 * treated as content on purpose: tools are not exposed on the embed surface
 * yet, and the frame's `text` is still the visible delta.
 *
 * FOOTGUN: this string is embedded in script data - never add a literal
 * closing script tag inside it.
 */
export const EMBED_SSE_PARSER_SRC = String.raw`function createSseParser(handlers) {
  var buffer = '';
  var done = false;
  function handleFrame(frame) {
    if (done) return;
    var lines = frame.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ':') continue;
      if (line.indexOf('data: ') !== 0) continue;
      var data = line.slice(6);
      if (data === '[DONE]') {
        done = true;
        if (handlers.onDone) handlers.onDone();
        return;
      }
      var evt;
      try {
        evt = JSON.parse(data);
      } catch (e) {
        continue;
      }
      if (!evt || typeof evt !== 'object') continue;
      if (evt.type === 'meta') {
        if (handlers.onMeta) handlers.onMeta(evt.requestId);
      } else if (evt.type === 'content' || evt.type === 'tool_use') {
        if (handlers.onContent) handlers.onContent(typeof evt.text === 'string' ? evt.text : '');
      } else if (evt.type === 'error') {
        done = true;
        if (handlers.onError) handlers.onError(typeof evt.message === 'string' ? evt.message : 'Stream error');
        return;
      }
    }
  }
  return {
    push: function (chunk) {
      buffer += chunk;
      var idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        var frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleFrame(frame);
      }
    },
    flush: function () {
      if (buffer) {
        handleFrame(buffer);
        buffer = '';
      }
    },
    isDone: function () {
      return done;
    }
  };
}`;
