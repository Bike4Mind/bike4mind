---
title: JavaScript/TypeScript Examples
description: Production-ready JavaScript and TypeScript code examples for the B4M Completions API
sidebar_position: 1
---

# JavaScript/TypeScript Examples

Production-ready code examples for integrating the B4M Completions API with JavaScript and TypeScript. The first three sections define the stream loop, the error type and the retry helper once. Every later sample imports them and shows only what it adds.

## Prefer the Typed SDK

If you do not need to control the stream parsing yourself, install the typed client:

```bash
npm install @bike4mind/sdk
```

```typescript
import { createClient } from '@bike4mind/sdk';
import { CompletionError, assertCompleteStopReason, withRetry } from './b4m-stream.js';

const b4m = createClient({
  baseUrl: 'https://app.bike4mind.com',
  apiKey: process.env.B4M_API_KEY,
});

await withRetry(async () => {
  let text = ''; // Reset partial output on every attempt
  let stopReason: string | undefined;
  let requestId: string | undefined;
  for await (const event of b4m.completions({
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: 'Hello!' }],
  })) {
    if (event.type === 'meta') requestId = event.requestId;
    if (event.type === 'content' || event.type === 'tool_use') {
      stopReason = event.stopReason ?? stopReason;
    }
    if (event.type === 'content') text += event.text;
    // The SDK yields in-band error events instead of throwing them
    if (event.type === 'error') {
      throw new CompletionError(event.message, { code: event.code, requestId: event.requestId });
    }
  }
  assertCompleteStopReason(stopReason, requestId);
  process.stdout.write(text); // Publish only a successful attempt
});

const models = await b4m.call('listModels');
```

The SDK sample imports the helpers defined below; save those sections as `b4m-stream.js` first. `completions()` throws `B4mStreamEndedError` when a stream ends without `[DONE]`. The SDK does not retry; wrap calls in the retry helper below. The rest of this page uses plain `fetch`, which runs in Node 18+ and browsers.

---

## Basic Streaming Example

Save this as `b4m-stream.js`. It is the one stream loop and the one error type that the other samples reuse:

```javascript
export function retryAfterSeconds(value) {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export class CompletionError extends Error {
  constructor(message, { status, code, requestId, retryAfter } = {}) {
    super(message);
    this.name = 'CompletionError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
  }
}

const INCOMPLETE_STOP_REASONS = new Set(['max_tokens', 'degenerate_repetition', 'refusal', 'pause_turn']);

export function assertCompleteStopReason(stopReason, requestId) {
  // Older servers and some providers omit this field; absence alone is not failure.
  if (!INCOMPLETE_STOP_REASONS.has(stopReason)) return;
  const message = stopReason === 'max_tokens'
    ? 'Reply truncated: max_tokens reached'
    : `Reply did not finish: ${stopReason}`;
  throw new CompletionError(message, { code: stopReason, requestId });
}

/**
 * Streams a completion and calls onEvent for every event before [DONE].
 * Throws CompletionError on an HTTP error, an in-band error event, or a
 * known incomplete stop reason, or a stream that ends without [DONE].
 */
export async function streamCompletion(
  body,
  onEvent,
  { apiKey, url = 'https://app.bike4mind.com/api/ai/v1/completions', signal } = {}
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed = {};
    try {
      const body = JSON.parse(text);
      if (body && typeof body === 'object' && !Array.isArray(body)) parsed = body;
    } catch {
      // Not JSON: fall back to the raw text
    }
    throw new CompletionError(parsed.error ?? text, {
      status: response.status,
      code: parsed.errorCode,
      requestId: parsed.request_id,
      retryAfter: retryAfterSeconds(response.headers.get('Retry-After')),
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
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          assertCompleteStopReason(stopReason, requestId);
          return;
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch {
          throw new CompletionError(`Malformed stream event: ${data}`);
        }
        if (event.requestId) requestId = event.requestId;
        if (typeof event.stopReason === 'string') stopReason = event.stopReason;

        // The HTTP status is already 200, so a failure arrives as an event
        if (event.type === 'error') {
          throw new CompletionError(event.message, {
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
      await reader.cancel(); // Also stops the upstream request when onEvent throws
    } catch (cleanupError) {
      console.warn('Could not cancel completion stream', cleanupError);
    } finally {
      reader.releaseLock();
    }
  }

  throw new CompletionError('Stream ended without [DONE] or an error event');
}
```

Use it:

```javascript
import { streamCompletion } from './b4m-stream.js';

try {
  await streamCompletion(
    { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'Write a haiku about coding' }] },
    (event) => {
      if (event.type === 'content') process.stdout.write(event.text);
    },
    { apiKey: process.env.B4M_API_KEY }
  );
  console.log('\nDone');
} catch (err) {
  console.error('Error:', err.code ?? err.status, err.requestId, err.message);
}
```

---

## Retry Helper

Add this to `b4m-stream.js`. It is the one retry helper; see the [retry table](../errors.md) for which failures are worth retrying:

```javascript
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Retry only 429, 500, 503 and in-band provider_error
      const retryable = [429, 500, 503].includes(error.status) || error.code === 'provider_error';
      if (!retryable || attempt >= maxAttempts - 1) throw error;

      // Honor Retry-After when present; otherwise back off 1s, 2s, 4s
      await sleep((error.retryAfter ?? error.retryAfterSeconds ?? 2 ** attempt) * 1000);
    }
  }
}
```

```javascript
import { streamCompletion, withRetry } from './b4m-stream.js';

await withRetry(() => streamCompletion(body, onEvent, { apiKey: process.env.B4M_API_KEY }));
```

A retry restarts the stream from the beginning. Reset accumulators inside `fn` on every attempt, and publish buffered output only after success, as in the SDK example. Do not automatically retry a callback that executes tools or performs other side effects.

---

## TypeScript Client Class

A thin typed wrapper over the helpers above. It adds types and a `complete()` method that returns the full text, retrying the whole request on a transient failure:

```typescript
import { streamCompletion, withRetry } from './b4m-stream.js';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | unknown[];
}

interface CompletionOptions {
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
}

interface SSEEvent {
  type: 'meta' | 'content' | 'tool_use' | 'provider_block';
  text?: string;
  tools?: { id?: string; name: string; arguments?: string }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

export class B4MCompletionClient {
  constructor(
    private apiKey: string,
    private baseUrl = 'https://app.bike4mind.com'
  ) {
    if (!apiKey) throw new Error('API key is required');
  }

  stream(model: string, messages: Message[], options?: CompletionOptions, onEvent: (e: SSEEvent) => void = () => {}) {
    return streamCompletion({ model, messages, ...options }, onEvent, {
      apiKey: this.apiKey,
      url: `${this.baseUrl}/api/ai/v1/completions`,
    });
  }

  complete(model: string, messages: Message[], options?: CompletionOptions): Promise<string> {
    return withRetry(async () => {
      let text = '';
      await this.stream(model, messages, options, (event) => {
        if (event.type === 'content') text += event.text;
      });
      return text;
    });
  }
}

// Usage
const client = new B4MCompletionClient(process.env.B4M_API_KEY!);

await client.stream('claude-sonnet-5', [{ role: 'user', content: 'Hello!' }], { max_tokens: 1024 }, (event) => {
  if (event.type === 'content') process.stdout.write(event.text!);
});

console.log(await client.complete('claude-sonnet-5', [{ role: 'user', content: 'What is 2+2?' }]));
```

---

## React Hook

The browser calls your own server route, which holds the API key and forwards the request:

:::warning
Never put your API key in browser code. Variables such as `NEXT_PUBLIC_*` are bundled into the page and visible to every visitor.
:::

Server route (Next.js `app/api/chat/route.ts`), with `B4M_API_KEY` set as a server-only environment variable. `authenticateUser` below is your application's authentication and authorization integration: implement it to return the current user and their `canUseAI` permission before enabling this route:

```typescript
export async function POST(req: Request) {
  const user = await authenticateUser(req); // Your app's server-side auth integration
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (!user.canUseAI) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const upstream = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.B4M_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: await req.text(),
    signal: req.signal,
  });

  // Pass the upstream status and SSE body through unchanged
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') ?? 'text/event-stream',
      ...(upstream.headers.has('Retry-After') && { 'Retry-After': upstream.headers.get('Retry-After')! }),
    },
  });
}
```

The hook reuses `streamCompletion`, pointed at that route and with no `apiKey`. The proxy passes errors and the stream through unchanged, so the same parsing and `CompletionError` apply:

```typescript
import { useState, useCallback } from 'react';
import { streamCompletion } from './b4m-stream.js';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export function useCompletion({ model = 'claude-sonnet-5', endpoint = '/api/chat' } = {}) {
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useCallback(async (messages: Message[]) => {
    setResponse('');
    setError(null);
    setLoading(true);
    try {
      await streamCompletion({ model, messages }, (event) => {
        if (event.type === 'content') setResponse((prev) => prev + event.text);
      }, { url: endpoint });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [model, endpoint]);

  return { response, loading, error, complete };
}

// Usage in a component
function Chat() {
  const { response, loading, error, complete } = useCompletion();

  return (
    <div>
      <button disabled={loading} onClick={() => complete([{ role: 'user', content: 'Hello!' }])}>
        {loading ? 'Sending...' : 'Send'}
      </button>
      {error && <div className="error">{error}</div>}
      <div className="response">{response}</div>
    </div>
  );
}
```

---

## Tool Calling Example

Complete tool calling loop. B4M returns each tool call with an `id` and `arguments` as a JSON string:

```typescript
import { streamCompletion } from './b4m-stream.js';

async function completionWithTools(apiKey: string, userQuery: string) {
  const tools = [
    {
      toolSchema: {
        name: 'get_weather',
        description: 'Get current weather for a location',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: 'City name' } },
          required: ['location'],
        },
      },
    },
  ];

  const messages: unknown[] = [{ role: 'user', content: userQuery }];

  while (true) {
    let toolCalls: { id?: string; name: string; arguments?: string }[] = [];
    let responseText = '';
    let thinking: unknown[] = [];

    await streamCompletion({ model: 'claude-sonnet-5', messages, tools }, (event) => {
      if (event.type === 'content' || event.type === 'tool_use') responseText += event.text;
      if (event.type === 'tool_use') toolCalls = event.tools ?? [];
      if (event.thinking) thinking = event.thinking;
    }, { apiKey });

    if (toolCalls.length === 0) return responseText;

    const parsed = toolCalls.map((tool) => ({ ...tool, input: JSON.parse(tool.arguments ?? '{}') }));

    messages.push({
      role: 'assistant',
      content: [
        ...thinking, // Replay signed thinking/redacted_thinking blocks unchanged
        ...(responseText ? [{ type: 'text', text: responseText }] : []),
        ...parsed.map((t) => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
      ],
    });

    const results = await Promise.all(
      parsed.map(async (t) => ({
        type: 'tool_result',
        tool_use_id: t.id,
        content: JSON.stringify(await executeTool(t.name, t.input)),
      }))
    );
    messages.push({ role: 'user', content: results });
  }
}

async function executeTool(name: string, input: { location: string }) {
  if (name === 'get_weather') {
    // Mock weather API call
    return { location: input.location, temperature: 72, condition: 'Sunny' };
  }
  throw new Error(`Unknown tool: ${name}`);
}

console.log(await completionWithTools(process.env.B4M_API_KEY!, 'What is the weather in San Francisco?'));
```

---

## Rate Limiting

Client-side limiter. Set the limit to your own plan's limit, listed in the [in-app API reference](https://app.bike4mind.com/api/v1/docs):

```typescript
class RateLimiter {
  private requests: number[] = [];

  constructor(private requestsPerMinute: number) {
    if (!Number.isInteger(requestsPerMinute) || requestsPerMinute < 1) {
      throw new Error('requestsPerMinute must be a positive integer');
    }
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    this.requests = this.requests.filter((time) => time > now - 60_000);

    if (this.requests.length >= this.requestsPerMinute) {
      await new Promise((resolve) => setTimeout(resolve, 60_000 - (now - this.requests[0])));
      return this.waitForSlot();
    }

    this.requests.push(now);
  }
}
```

---

## Production Example

Combine the pieces: a rate limiter in front, `withRetry` around the stream, and events for logging:

```typescript
import { EventEmitter } from 'events';
import { streamCompletion, withRetry } from './b4m-stream.js';

class ProductionB4MClient extends EventEmitter {
  private rateLimiter: RateLimiter;

  constructor(private apiKey: string, requestsPerMinute: number, private maxRetries = 3) {
    super();
    if (!apiKey) throw new Error('API key is required');
    this.rateLimiter = new RateLimiter(requestsPerMinute);
  }

  async complete(model: string, messages: { role: string; content: string }[]): Promise<string> {
    let attempt = 0;
    return withRetry(async () => {
      await this.rateLimiter.waitForSlot();
      this.emit('reset'); // Consumers discard chunks from a failed attempt
      this.emit('attempt', { attempt: ++attempt, maxRetries: this.maxRetries });
      let full = '';
      try {
        await streamCompletion({ model, messages }, (event) => {
          if (event.type !== 'content') return;
          full += event.text;
          this.emit('chunk', event.text);
          if (event.usage) this.emit('usage', event.usage);
        }, { apiKey: this.apiKey });
      } catch (error) {
        this.emit('failure', error);
        throw error;
      }
      this.emit('complete', full);
      return full;
    }, this.maxRetries);
  }
}

// Usage
const requestsPerMinute = Number(process.env.B4M_REQUESTS_PER_MINUTE);
const client = new ProductionB4MClient(process.env.B4M_API_KEY!, requestsPerMinute);

let displayedText = '';
client.on('reset', () => { displayedText = ''; });
client.on('chunk', (text) => { displayedText += text; });
client.on('complete', () => process.stdout.write(displayedText));
client.on('usage', (usage) => console.log('\nTokens:', usage));
client.on('failure', (error) => console.error('Error:', error.message));

await client.complete('claude-sonnet-5', [{ role: 'user', content: 'Hello!' }]);
```

The event is named `failure` because Node throws on an `EventEmitter` `'error'` event that has no listener.

---

## Next Steps

- **[Python Examples](./python.md)** - See Python implementations
- **[curl Examples](./curl.md)** - Quick testing with curl
- **[Best Practices](../best-practices.md)** - Production patterns
- **[Error Handling](../errors.md)** - Handle errors properly
