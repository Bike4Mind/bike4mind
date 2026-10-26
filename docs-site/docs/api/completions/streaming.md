---
title: SSE Streaming Guide
description: Learn how to implement Server-Sent Events streaming for real-time AI responses
sidebar_position: 4
---

# SSE Streaming Guide

Learn how to implement Server-Sent Events (SSE) streaming for real-time AI completions.

## What is Server-Sent Events?

Server-Sent Events (SSE) is an HTTP standard for streaming data from server to client over a persistent connection.

**Key characteristics:**

- **Unidirectional:** Server → Client only (no client-to-server streaming)
- **HTTP-based:** Uses standard HTTP/HTTPS (no special protocol)
- **Auto-reconnection:** Built into browsers (for EventSource API)
- **Simpler than WebSockets:** No protocol upgrade needed

**Why SSE for AI completions?**

- **Real-time updates:** Display responses as they're generated
- **Better UX:** Users see progress instead of waiting for completion
- **Lower latency:** First tokens arrive quickly
- **Standard HTTP:** Works through proxies, load balancers, CDNs

## Connection Pattern

```
Client opens connection
  ↓
Server sends events
  ├─ data: event1
  ├─ data: event2
  └─ data: event3
  ↓
Server sends [DONE]
  ↓
Connection closes
```

## SSE Format

Each event follows this format:

```
data: {JSON payload}\n\n
```

**Key points:**
- Starts with `data: ` prefix
- Contains JSON payload
- Ends with double newline (`\n\n`)

**Example stream:**

```
data: {"type":"content","text":"Hello","usage":{"inputTokens":10,"outputTokens":5}}

data: {"type":"content","text":" world!","usage":{"inputTokens":10,"outputTokens":10}}

data: [DONE]

```

---

## Implementation Examples

### JavaScript (Fetch API)

The most common approach. In a browser, send the request through your own backend instead of exposing the key (see [Authentication](./authentication.md)):

```javascript
async function streamCompletion(messages, onEvent, { signal } = {}) {
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.B4M_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      messages: messages
    }),
    signal,
  });

  // Errors before the stream opens carry a real HTTP status
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${await response.text()}`), {
      status: response.status,
      retryAfterHeader: response.headers.get('Retry-After'), // Raw header; parse seconds or HTTP-date before retrying
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let stopReason;
  let requestId;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();

        if (data === '[DONE]') {
          if (['max_tokens', 'degenerate_repetition', 'refusal', 'pause_turn'].includes(stopReason)) {
            throw Object.assign(new Error(`Reply did not finish: ${stopReason}`), { code: stopReason, requestId });
          }
          return;
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error(`Malformed stream event: ${data}`);
        }
        if (event.requestId) requestId = event.requestId;
        if (typeof event.stopReason === 'string') stopReason = event.stopReason;

        // The HTTP status is already 200, so a failure arrives as an event
        if (event.type === 'error') {
          throw Object.assign(new Error(event.message), {
            status: response.status,
            code: event.code,
            requestId: event.requestId,
          });
        }

        onEvent(event);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch (cleanupError) {
      console.warn('Could not cancel completion stream', cleanupError);
    } finally {
      reader.releaseLock();
    }
  }

  throw new Error('Stream ended without [DONE] or an error event');
}

// Usage
try {
  await streamCompletion([{ role: 'user', content: 'What is 2+2?' }], (event) => {
    if (event.type === 'content') console.log(event.text, event.usage);
    else if (event.type === 'tool_use') console.log(event.tools, event.text);
  });
} catch (err) {
  console.error(err.code ?? err.status, err.requestId, err.message);
}
```

**Key points:**
1. Use `response.body.getReader()` for streaming, and cancel the stream and release the reader in a `finally` block.
2. Buffer incomplete lines: an event can be split across chunks, so parse only complete `data:` lines. A `JSON.parse` error such as "Unexpected end of JSON input" usually means a missing buffer.
3. `[DONE]` means the transport finished; check `stopReason` to tell a finished answer from an incomplete one. A stream that ends without it and without an `error` event is incomplete.
4. Wrap only `JSON.parse` in try/catch and treat malformed data as a failure; do not skip the line. Exceptions from your own handler must propagate.
5. An `error` event is terminal: throw with its `code` and `requestId`.
   The final `content` event carries `stopReason` when the provider reports one. `max_tokens` means the reply was truncated even though `[DONE]` follows: raise `max_tokens` or reduce thinking. A missing `stopReason` means unknown, not truncated. `degenerate_repetition` means B4M stopped a repeating stream; discard the unusable tail instead of treating it as a finished answer. `refusal` means the model declined the request. `pause_turn` requires continuing the conversation with its provider blocks, as described in the in-app reference; it is not a final answer. The samples reject these known incomplete reasons so callers can handle them explicitly; absent or unrecognized reasons remain compatible with older servers and new providers.
6. Check `response.ok` before you read the body, and log the raw `data` when parsing fails.
7. Ignore event types you do not recognize instead of throwing; new types can be added.
8. Pass an `AbortSignal` such as `AbortSignal.timeout(ms)` as the `signal` option so a stalled connection cannot hang forever.
9. Retry only transient failures, and restart the whole request. See [Errors](./errors.md#retry-guidance) for which ones.

---

### Node.js

Node 18 and later has a global `fetch`, so the sample above runs unchanged. In Node you can also replace the `getReader()` loop with `for await (const chunk of response.body)`, decoding each chunk with a `TextDecoder` in streaming mode. See the [JavaScript examples](./examples/javascript.md) for a complete client.

---

### Python (with requests + sseclient-py)

```python
import json
import os
import requests
from sseclient import SSEClient

class StreamError(Exception):
    def __init__(self, message, code=None, request_id=None):
        super().__init__(message)
        self.code = code
        self.request_id = request_id

def stream_completion(api_key: str, messages: list):
    """
    Raises requests.HTTPError for errors before the stream opens (inspect
    e.response.status_code and the Retry-After header), and StreamError for
    in-band errors and incomplete streams.
    """
    with requests.post(
        "https://app.bike4mind.com/api/ai/v1/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={"model": "claude-sonnet-5", "messages": messages},
        stream=True,  # Without this, requests buffers the whole response
    ) as response:
        response.raise_for_status()

        done = False
        stop_reason = None
        request_id = None
        for event in SSEClient(response).events():
            if event.data == "[DONE]":
                done = True
                break

            try:
                data = json.loads(event.data)
            except json.JSONDecodeError as e:
                raise StreamError(f"Malformed stream event: {event.data!r}") from e

            # The HTTP status is already 200, so a failure arrives as an event
            if data.get("type") == "error":
                raise StreamError(data["message"], data.get("code"), data.get("requestId"))

            request_id = data.get("requestId") or request_id
            stop_reason = data.get("stopReason") or stop_reason
            print(data)

        if not done:
            raise StreamError("Stream ended without [DONE] or an error event")
        if stop_reason in {"max_tokens", "degenerate_repetition", "refusal", "pause_turn"}:
            raise StreamError(f"Reply did not finish: {stop_reason}", stop_reason, request_id)

# Usage
if __name__ == "__main__":
    try:
        stream_completion(os.environ["B4M_API_KEY"], [{"role": "user", "content": "What is 2+2?"}])
    except StreamError as e:
        print(f"Stream failed: {e.code} (request {e.request_id}): {e}")
```

Install it with `pip install sseclient-py requests`. See the [Python examples](./examples/python.md) for a complete client.

---

### curl (for testing)

The simplest way to test SSE streaming:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {"role": "user", "content": "Count to 5"}
    ]
  }'
```

**Critical:** Always use `--no-buffer` to see streaming output in real-time. Without it, curl will buffer the entire response. Add `-v` to see the response headers.

---

## Error Handling

Errors can occur at two points in the stream lifecycle:

- **Before the stream starts** (authentication, validation, rate limiting): a JSON error body with a real HTTP status, and no SSE stream. Check `response.ok` first.
- **During the stream** (model errors, running out of credits): the HTTP status is already 200 and stays 200. One terminal SSE `error` event arrives, such as `{"type":"error","message":"...","requestId":"...","code":"provider_error"}`, and no `[DONE]` follows.

The `streamCompletion` function above throws on both. See [Errors](./errors.md) for the status codes, the `code` values and which ones to retry.

---

## Common Pitfalls

### Buffering

**Problem:** HTTP clients and proxies may buffer the response, so you see the whole answer at once or wait a long time before any output.

**Solutions:**

- **curl:** pass `--no-buffer`.
- **Python requests:** pass `stream=True`.
- **Node.js and browsers:** `fetch` streams by default.
- **Proxies (nginx, CDN):** the API does not set `X-Accel-Buffering`. If you proxy the stream yourself, disable response buffering and compression for the route (for nginx, `proxy_buffering off`, or send `X-Accel-Buffering: no` from your own proxy).

If a stream never starts, check the HTTP status, the `Authorization` header and that the request body is valid JSON. If it never ends, check that you return on `[DONE]` and stop reading afterward.

---

## Next Steps

- **[Tools & Function Calling](./tools.md)** - Add function calling to streams
- **[Code Examples](./examples/javascript.md)** - See complete implementations
- **[Error Handling](./errors.md)** - Handle stream errors
- **[Best Practices](./best-practices.md)** - Production streaming patterns
