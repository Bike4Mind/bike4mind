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

### JavaScript (Browser - Fetch API)

The most common approach for web applications:

```javascript
async function streamCompletion(messages) {
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.B4M_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: messages
    })
  });

  // Check for errors before streaming
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // Decode chunk and add to buffer
    buffer += decoder.decode(value, { stream: true });

    // Split by newlines
    const lines = buffer.split('\n');

    // Keep incomplete line in buffer
    buffer = lines.pop() || '';

    // Process complete lines
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();

        // Check for completion signal
        if (data === '[DONE]') {
          console.log('Stream complete');
          return;
        }

        try {
          const event = JSON.parse(data);
          handleEvent(event);
        } catch (err) {
          console.error('JSON parse error:', err, 'Raw data:', data);
        }
      }
    }
  }
}

function handleEvent(event) {
  switch (event.type) {
    case 'content':
      console.log('Content:', event.text);
      console.log('Usage:', event.usage);
      break;
    case 'tool_use':
      console.log('Tool call:', event.tools);
      console.log('Response:', event.text);
      break;
    case 'error':
      console.error('Error:', event.message);
      break;
    default:
      console.warn('Unknown event type:', event.type);
  }
}

// Usage
streamCompletion([
  { role: 'user', content: 'What is 2+2?' }
]);
```

**Key points:**
1. Use `response.body.getReader()` for streaming
2. Buffer incomplete lines (SSE events may span multiple chunks)
3. Parse only complete `data:` lines
4. Handle `[DONE]` signal to close stream
5. Always wrap JSON.parse in try/catch

---

### Node.js (with node-fetch)

For server-side JavaScript:

```javascript
import fetch from 'node-fetch';

async function streamCompletion(apiKey, messages) {
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet',
      messages: messages
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  let buffer = '';

  response.body.on('data', (chunk) => {
    buffer += chunk.toString();

    // Split by double newline (SSE message separator)
    const messages = buffer.split('\n\n');
    buffer = messages.pop() || ''; // Keep incomplete message

    for (const message of messages) {
      if (message.startsWith('data: ')) {
        const data = message.slice(6).trim();

        if (data === '[DONE]') {
          console.log('Stream complete');
          return;
        }

        try {
          const event = JSON.parse(data);
          handleEvent(event);
        } catch (err) {
          console.error('Parse error:', err);
        }
      }
    }
  });

  response.body.on('end', () => {
    console.log('Connection closed');
  });

  response.body.on('error', (err) => {
    console.error('Stream error:', err);
  });
}

// Usage
const apiKey = process.env.B4M_API_KEY;
const messages = [{ role: 'user', content: 'What is 2+2?' }];
streamCompletion(apiKey, messages);
```

---

### Python (with requests + sseclient-py)

```python
import json
import os
import requests
from sseclient import SSEClient

def stream_completion(api_key: str, messages: list):
    """
    Stream a completion from the B4M API.

    Args:
        api_key: B4M API key
        messages: List of message dicts with 'role' and 'content'
    """
    url = "https://app.bike4mind.com/api/ai/v1/completions"
    headers = {
        "X-API-Key": api_key,
        "Content-Type": "application/json",
    }
    payload = {
        "model": "claude-3-5-sonnet",
        "messages": messages
    }

    response = requests.post(url, headers=headers, json=payload, stream=True)
    response.raise_for_status()  # Raise error for non-200 status

    client = SSEClient(response)

    for event in client.events():
        if event.data == "[DONE]":
            print("\n✓ Stream complete")
            break

        try:
            data = json.loads(event.data)
            handle_event(data)
        except json.JSONDecodeError as e:
            print(f"\nJSON parse error: {e}")

def handle_event(event):
    event_type = event.get("type")

    if event_type == "content":
        print(f"Content: {event['text']}")
        print(f"Usage: {event.get('usage', {})}")
    elif event_type == "tool_use":
        print(f"Tool call: {event['tools']}")
        print(f"Response: {event['text']}")
    elif event_type == "error":
        print(f"Error: {event['message']}")
    else:
        print(f"Unknown event type: {event_type}")

# Usage
if __name__ == "__main__":
    api_key = os.environ.get("B4M_API_KEY")
    messages = [{"role": "user", "content": "What is 2+2?"}]
    stream_completion(api_key, messages)
```

**Install sseclient-py:**

```bash
pip install sseclient-py requests
```

---

### curl (for testing)

The simplest way to test SSE streaming:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

**Critical:** Always use `--no-buffer` to see streaming output in real-time. Without it, curl will buffer the entire response.

---

## Error Handling

Errors can occur at two points in the stream lifecycle.

### 1. Before Streaming Starts

These errors occur during connection setup (authentication, validation, rate limiting).

**Indicators:**
- HTTP error status (401, 403, 429, 500, etc.)
- No SSE stream starts

**Example handling:**

```javascript
const response = await fetch(...);

// Check HTTP status first
if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`HTTP ${response.status}: ${errorText}`);
}

// If OK, start parsing stream
const reader = response.body.getReader();
// ...
```

### 2. During Streaming

These errors occur while the stream is active (model errors, timeouts, etc.).

**Indicators:**
- SSE error event: `{"type":"error","message":"..."}`
- Stream is active but returns error

**Example handling:**

```javascript
function handleEvent(event) {
  if (event.type === 'error') {
    throw new Error(`Stream error: ${event.message}`);
  }

  // Handle other event types
  // ...
}
```

**Complete error handling example:**

```javascript
async function streamWithErrorHandling(messages) {
  try {
    const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.B4M_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: messages
      })
    });

    // Error before streaming
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              return; // Success
            }

            const event = JSON.parse(data);

            // Error during streaming
            if (event.type === 'error') {
              throw new Error(`Stream error: ${event.message}`);
            }

            handleEvent(event);
          }
        }
      }
    } finally {
      reader.releaseLock(); // Always release reader
    }

  } catch (error) {
    console.error('Stream failed:', error);
    throw error;
  }
}
```

---

## Common Pitfalls

### 1. Buffering Issues

**Problem:** HTTP clients may buffer responses, preventing real-time streaming.

**Symptoms:**
- Seeing entire response at once instead of chunks
- Long wait before any output appears

**Solutions:**

**curl:**
```bash
curl --no-buffer ...  # Always use this flag
```

**Python requests:**
```python
response = requests.post(..., stream=True)  # Set stream=True
```

**Node.js:** Streams work correctly by default

**Proxies (nginx, CDN):** The API sets `X-Accel-Buffering: no` to disable buffering

---

### 2. Partial JSON Parsing

**Problem:** SSE events may arrive split across multiple chunks, causing JSON.parse errors.

**Symptoms:**
- "Unexpected end of JSON input" errors
- "Unexpected token" at start of JSON

**Solution:** Always buffer incomplete lines

```javascript
let buffer = '';

for (const chunk of chunks) {
  buffer += chunk;

  const lines = buffer.split('\n');
  buffer = lines.pop() || ''; // Keep incomplete line

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim();

      // Now safe to parse
      const event = JSON.parse(data);
    }
  }
}
```

---

### 3. Not Handling [DONE]

**Problem:** Continuing to read stream after [DONE] signal.

**Symptoms:**
- Stream never closes
- Memory leaks from unclosed connections

**Solution:** Always check for [DONE] and return/break

```javascript
if (data === '[DONE]') {
  console.log('Stream complete');
  return; // Exit stream handler
}
```

---

### 4. Memory Leaks

**Problem:** Not closing readers/connections properly.

**Symptoms:**
- Increasing memory usage over time
- "Too many open connections" errors

**Solution:** Always clean up in `finally` blocks

```javascript
const reader = response.body.getReader();

try {
  // Stream processing
} finally {
  reader.releaseLock(); // Always release
}
```

---

### 5. Ignoring Unknown Event Types

**Problem:** Future API versions may add new event types.

**Symptoms:**
- Code breaks when new event types are added

**Solution:** Handle unknown types gracefully

```javascript
function handleEvent(event) {
  switch (event.type) {
    case 'content':
      // Handle content
      break;
    case 'tool_use':
      // Handle tool use
      break;
    case 'error':
      // Handle error
      break;
    default:
      // Log but don't crash
      console.warn('Unknown event type:', event.type);
  }
}
```

---

## Best Practices

### 1. Buffer Incomplete Lines

Always keep incomplete SSE lines in a buffer:

```javascript
let buffer = '';

// For each chunk
buffer += decodedChunk;
const lines = buffer.split('\n');
buffer = lines.pop() || ''; // Keep last (potentially incomplete) line
```

### 2. Handle All Event Types

Process all event types, including unknown ones:

```javascript
switch (event.type) {
  case 'content':      // Content
  case 'tool_use':     // Tool calls
  case 'error':        // Errors
  default:             // Unknown (log, don't crash)
}
```

### 3. Implement Timeouts

Don't wait forever for [DONE]:

```javascript
const TIMEOUT_MS = 60000; // 60 seconds

const timeoutPromise = new Promise((_, reject) => {
  setTimeout(() => reject(new Error('Stream timeout')), TIMEOUT_MS);
});

const streamPromise = streamCompletion(messages);

await Promise.race([streamPromise, timeoutPromise]);
```

### 4. Close Streams Properly

Always clean up resources:

```javascript
try {
  await streamCompletion(messages);
} finally {
  reader.releaseLock();
  // Close any other resources
}
```

### 5. Log Parsing Errors

Debug SSE parsing issues:

```javascript
try {
  const event = JSON.parse(data);
} catch (err) {
  console.error('Parse error:', err);
  console.error('Raw data:', data); // Log what failed to parse
}
```

### 6. Check HTTP Status First

Validate response before parsing stream:

```javascript
if (!response.ok) {
  throw new Error(`HTTP ${response.status}`);
}

// Now safe to parse stream
```

### 7. Use Exponential Backoff

Retry failed streams with backoff:

```javascript
async function streamWithRetry(messages, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await streamCompletion(messages);
    } catch (err) {
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}
```

---

## Testing Streams

### Testing with curl

```bash
# Basic test
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Count to 5"}]
  }'

# Verbose (shows headers)
curl -v --no-buffer ...

# Save to file
curl --no-buffer ... > output.txt
```

### Testing Programmatically

```javascript
async function testStream() {
  console.log('Testing SSE stream...');

  const messages = [{ role: 'user', content: 'Say hello' }];

  let eventCount = 0;
  let receivedDone = false;

  await streamCompletion(messages, (event) => {
    eventCount++;
    console.log(`Event ${eventCount}:`, event.type);

    if (event.type === 'content') {
      console.log('  Text:', event.text);
    }
  });

  receivedDone = true;

  console.log(`✓ Stream test passed`);
  console.log(`  Events received: ${eventCount}`);
  console.log(`  [DONE] signal: ${receivedDone ? 'yes' : 'no'}`);
}

testStream();
```

---

## Troubleshooting

### Stream Never Starts

**Check:**
1. HTTP status code (should be 200)
2. Authentication header (valid API key)
3. Request body (valid JSON, correct schema)

### Stream Buffers Instead of Streaming

**Check:**
1. Using `--no-buffer` in curl
2. Using `stream=True` in Python requests
3. Not using incorrect HTTP client
4. No buffering proxies in the middle

### JSON Parse Errors

**Check:**
1. Buffering incomplete lines properly
2. Splitting by `\n\n` for SSE message boundaries
3. Wrapping JSON.parse in try/catch
4. Logging raw data before parsing

### Stream Never Ends

**Check:**
1. Handling `[DONE]` signal properly
2. Closing connection after [DONE]
3. Not continuing to read after completion
4. Implementing timeout for safety

---

## Next Steps

- **[Tools & Function Calling](/api/completions/tools)** - Add function calling to streams
- **[Code Examples](/api/completions/examples/javascript)** - See complete implementations
- **[Error Handling](/api/completions/errors)** - Handle stream errors
- **[Best Practices](/api/completions/best-practices)** - Production streaming patterns
