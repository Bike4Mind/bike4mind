---
title: JavaScript/TypeScript Examples
description: Production-ready JavaScript and TypeScript code examples for the B4M Completions API
sidebar_position: 1
---

# JavaScript/TypeScript Examples

Production-ready code examples for integrating the B4M Completions API with JavaScript and TypeScript.

## Basic Streaming Example

Simple streaming implementation using the Fetch API:

```javascript
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
            console.log('\n✓ Stream complete');
            return;
          }

          const event = JSON.parse(data);

          if (event.type === 'content') {
            process.stdout.write(event.text);
          } else if (event.type === 'error') {
            throw new Error(`Stream error: ${event.message}`);
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Usage
const apiKey = process.env.B4M_API_KEY;
const messages = [
  { role: 'user', content: 'Write a haiku about coding' }
];

streamCompletion(apiKey, messages)
  .then(() => console.log('Done!'))
  .catch(err => console.error('Error:', err));
```

---

## TypeScript Client Class

Complete TypeScript implementation with full type safety:

```typescript
import fetch from 'node-fetch';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string | any[];
}

interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  tools?: any[];
}

interface SSEContentEvent {
  type: 'content' | 'tool_use';
  text: string;
  tools?: any[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  thinking?: any[];
}

interface SSEErrorEvent {
  type: 'error';
  message: string;
}

type SSEEvent = SSEContentEvent | SSEErrorEvent;

class B4MCompletionClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = 'https://app.bike4mind.com') {
    if (!apiKey) {
      throw new Error('API key is required');
    }
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async streamCompletion(
    model: string,
    messages: Message[],
    options?: CompletionOptions,
    onEvent?: (event: SSEEvent) => void
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/ai/v1/completions`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        options
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const reader = response.body!.getReader();
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
              return;
            }

            try {
              const event = JSON.parse(data) as SSEEvent;

              if (event.type === 'error') {
                throw new Error(`Stream error: ${event.message}`);
              }

              if (onEvent) {
                onEvent(event);
              }
            } catch (parseError) {
              console.error('JSON parse error:', parseError, 'Raw:', data);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(
    model: string,
    messages: Message[],
    options?: CompletionOptions
  ): Promise<string> {
    let fullResponse = '';

    await this.streamCompletion(model, messages, options, (event) => {
      if (event.type === 'content') {
        fullResponse += event.text;
      }
    });

    return fullResponse;
  }
}

// Usage
const client = new B4MCompletionClient(process.env.B4M_API_KEY!);

// Streaming with callback
await client.streamCompletion(
  'claude-3-5-sonnet',
  [{ role: 'user', content: 'Hello!' }],
  { temperature: 0.7, maxTokens: 1024 },
  (event) => {
    if (event.type === 'content') {
      process.stdout.write(event.text);
    }
  }
);

// Non-streaming (waits for complete response)
const response = await client.complete(
  'claude-3-5-sonnet',
  [{ role: 'user', content: 'What is 2+2?' }]
);
console.log(response);
```

---

## React Hook

React hook for easy integration in React applications:

```typescript
import { useState, useCallback } from 'react';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface UseCompletionOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface CompletionState {
  response: string;
  loading: boolean;
  error: string | null;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
  } | null;
}

export function useCompletion(options: UseCompletionOptions) {
  const {
    apiKey,
    model = 'claude-3-5-sonnet',
    baseUrl = 'https://app.bike4mind.com'
  } = options;

  const [state, setState] = useState<CompletionState>({
    response: '',
    loading: false,
    error: null,
    usage: null,
  });

  const complete = useCallback(async (messages: Message[]) => {
    setState({
      response: '',
      loading: true,
      error: null,
      usage: null,
    });

    try {
      const response = await fetch(`${baseUrl}/api/ai/v1/completions`, {
        method: 'POST',
        headers: {
          'X-API-Key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('Response body is null');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') break;

            try {
              const event = JSON.parse(data);

              if (event.type === 'content') {
                fullResponse += event.text;
                setState(prev => ({
                  ...prev,
                  response: fullResponse,
                  usage: event.usage || prev.usage,
                }));
              } else if (event.type === 'error') {
                throw new Error(event.message);
              }
            } catch (parseError) {
              console.error('Parse error:', parseError);
            }
          }
        }
      }

      setState(prev => ({ ...prev, loading: false }));

    } catch (error: any) {
      setState(prev => ({
        ...prev,
        loading: false,
        error: error.message,
      }));
    }
  }, [apiKey, model, baseUrl]);

  const reset = useCallback(() => {
    setState({
      response: '',
      loading: false,
      error: null,
      usage: null,
    });
  }, []);

  return {
    ...state,
    complete,
    reset,
  };
}

// Usage in component
function ChatComponent() {
  const { response, loading, error, usage, complete, reset } = useCompletion({
    apiKey: process.env.NEXT_PUBLIC_B4M_API_KEY!,
  });

  const [input, setInput] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    await complete([
      { role: 'user', content: input }
    ]);

    setInput('');
  };

  return (
    <div>
      <form onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          disabled={loading}
        />
        <button type="submit" disabled={loading}>
          {loading ? 'Sending...' : 'Send'}
        </button>
      </form>

      {error && <div className="error">{error}</div>}

      <div className="response">
        {response || (loading ? 'Thinking...' : 'Response will appear here')}
      </div>

      {usage && (
        <div className="usage">
          Tokens: {usage.inputTokens} in / {usage.outputTokens} out
        </div>
      )}

      {response && (
        <button onClick={reset}>Clear</button>
      )}
    </div>
  );
}
```

---

## Error Handling with Retry

Complete error handling with exponential backoff:

```typescript
class B4MClientWithRetry extends B4MCompletionClient {
  private maxRetries: number;

  constructor(apiKey: string, baseUrl?: string, maxRetries = 3) {
    super(apiKey, baseUrl);
    this.maxRetries = maxRetries;
  }

  async streamCompletionWithRetry(
    model: string,
    messages: Message[],
    options?: CompletionOptions,
    onEvent?: (event: SSEEvent) => void
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.streamCompletion(model, messages, options, onEvent);
      } catch (error: any) {
        // Parse HTTP status from error message
        const statusMatch = error.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : null;

        // Rate limited - wait and retry
        if (status === 429) {
          // Extract Retry-After from error if available
          const retryAfter = 60; // Default to 60 seconds
          console.log(`Rate limited. Waiting ${retryAfter}s (attempt ${attempt + 1})...`);
          await this.sleep(retryAfter * 1000);
          continue;
        }

        // Server error - exponential backoff
        if (status && status >= 500) {
          if (attempt < this.maxRetries - 1) {
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            console.log(`Server error. Retrying in ${delay}ms (attempt ${attempt + 1})...`);
            await this.sleep(delay);
            continue;
          }
        }

        // Other errors - don't retry
        throw error;
      }
    }

    throw new Error(`Failed after ${this.maxRetries} attempts`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Usage
const client = new B4MClientWithRetry(process.env.B4M_API_KEY!, undefined, 3);

await client.streamCompletionWithRetry(
  'claude-3-5-sonnet',
  [{ role: 'user', content: 'Hello!' }],
  undefined,
  (event) => {
    if (event.type === 'content') {
      console.log(event.text);
    }
  }
);
```

---

## Tool Calling Example

Complete tool calling implementation:

```typescript
interface Tool {
  toolSchema: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, any>;
      required: string[];
    };
  };
}

async function completionWithTools(
  client: B4MCompletionClient,
  userQuery: string
) {
  const tools: Tool[] = [
    {
      toolSchema: {
        name: 'get_weather',
        description: 'Get current weather for a location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'City name'
            }
          },
          required: ['location']
        }
      }
    }
  ];

  const messages: Message[] = [
    { role: 'user', content: userQuery }
  ];

  while (true) {
    let toolCalls: any[] = [];
    let responseText = '';

    await client.streamCompletion(
      'claude-3-5-sonnet',
      messages,
      { tools },
      (event) => {
        if (event.type === 'content') {
          responseText += event.text;
        } else if (event.type === 'tool_use') {
          responseText += event.text;
          toolCalls = event.tools || [];
        }
      }
    );

    // No tool calls - we're done
    if (toolCalls.length === 0) {
      return responseText;
    }

    // Execute tools
    // Note: B4M returns tools with 'arguments' (JSON string) and 'id'
    // Parse arguments to get input object
    console.log('Executing tools:', toolCalls);

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: [
        { type: 'text', text: responseText },
        ...toolCalls.map((tool) => {
          // Parse arguments from JSON string if needed
          const input = typeof tool.arguments === 'string'
            ? JSON.parse(tool.arguments)
            : tool.input;
          return {
            type: 'tool_use',
            id: tool.id,  // Use the actual ID from B4M response
            name: tool.name,
            input: input
          };
        })
      ]
    });

    // Execute tools and add results
    const toolResults = await Promise.all(
      toolCalls.map(async (tool) => {
        const input = typeof tool.arguments === 'string'
          ? JSON.parse(tool.arguments)
          : tool.input;
        const result = await executeTool(tool.name, input);
        return {
          type: 'tool_result',
          tool_use_id: tool.id,  // Use the actual ID from B4M response
          content: JSON.stringify(result)
        };
      })
    );

    messages.push({
      role: 'user',
      content: toolResults
    });

    // Continue loop for final response
  }
}

async function executeTool(name: string, input: any): Promise<any> {
  switch (name) {
    case 'get_weather':
      // Mock weather API call
      return {
        location: input.location,
        temperature: 72,
        condition: 'Sunny',
        humidity: 45
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// Usage
const client = new B4MCompletionClient(process.env.B4M_API_KEY!);
const result = await completionWithTools(client, 'What is the weather in San Francisco?');
console.log(result);
```

---

## Rate Limiting

Client-side rate limiting implementation:

```typescript
class RateLimiter {
  private requestsPerMinute: number;
  private requests: number[] = [];

  constructor(requestsPerMinute: number) {
    this.requestsPerMinute = requestsPerMinute;
  }

  async waitForSlot(): Promise<void> {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old requests
    this.requests = this.requests.filter(time => time > oneMinuteAgo);

    if (this.requests.length >= this.requestsPerMinute) {
      const oldestRequest = this.requests[0];
      const waitTime = 60000 - (now - oldestRequest);

      console.log(`Rate limit: waiting ${Math.ceil(waitTime / 1000)}s`);

      await new Promise(resolve => setTimeout(resolve, waitTime));

      // Recursive call to check again
      return this.waitForSlot();
    }

    this.requests.push(now);
  }
}

// Usage with client
const limiter = new RateLimiter(60); // 60 requests per minute
const client = new B4MCompletionClient(process.env.B4M_API_KEY!);

async function makeRateLimitedRequest(messages: Message[]) {
  await limiter.waitForSlot();

  return client.complete('claude-3-5-sonnet', messages);
}
```

---

## Complete Production Example

Full production-ready implementation with all features:

```typescript
import fetch from 'node-fetch';
import { EventEmitter } from 'events';

interface CompletionConfig {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  requestsPerMinute?: number;
}

class ProductionB4MClient extends EventEmitter {
  private apiKey: string;
  private baseUrl: string;
  private maxRetries: number;
  private rateLimiter: RateLimiter;

  constructor(config: CompletionConfig) {
    super();

    if (!config.apiKey) {
      throw new Error('API key is required');
    }

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://app.bike4mind.com';
    this.maxRetries = config.maxRetries || 3;
    this.rateLimiter = new RateLimiter(config.requestsPerMinute || 60);
  }

  async complete(
    model: string,
    messages: Message[],
    options?: CompletionOptions
  ): Promise<string> {
    // Wait for rate limit slot
    await this.rateLimiter.waitForSlot();

    // Retry logic
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        this.emit('attempt', { attempt: attempt + 1, maxRetries: this.maxRetries });

        let fullResponse = '';

        await this.streamCompletion(model, messages, options, (event) => {
          if (event.type === 'content') {
            fullResponse += event.text;
            this.emit('chunk', event.text);

            if (event.usage) {
              this.emit('usage', event.usage);
            }
          }
        });

        this.emit('complete', fullResponse);
        return fullResponse;

      } catch (error: any) {
        this.emit('error', error);

        const statusMatch = error.message.match(/HTTP (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : null;

        // Rate limited
        if (status === 429) {
          const retryAfter = 60;
          console.log(`Rate limited. Waiting ${retryAfter}s...`);
          await this.sleep(retryAfter * 1000);
          continue;
        }

        // Server error
        if (status && status >= 500 && attempt < this.maxRetries - 1) {
          const delay = Math.pow(2, attempt) * 1000;
          console.log(`Server error. Retrying in ${delay}ms...`);
          await this.sleep(delay);
          continue;
        }

        // Non-retryable error
        throw error;
      }
    }

    throw new Error(`Failed after ${this.maxRetries} attempts`);
  }

  private async streamCompletion(
    model: string,
    messages: Message[],
    options?: CompletionOptions,
    onEvent?: (event: SSEEvent) => void
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/ai/v1/completions`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, messages, options })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
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

            if (data === '[DONE]') return;

            try {
              const event = JSON.parse(data) as SSEEvent;

              if (event.type === 'error') {
                throw new Error(`Stream error: ${event.message}`);
              }

              if (onEvent) onEvent(event);
            } catch (parseError) {
              console.error('Parse error:', parseError);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Usage
const client = new ProductionB4MClient({
  apiKey: process.env.B4M_API_KEY!,
  maxRetries: 3,
  requestsPerMinute: 60
});

// Listen to events
client.on('attempt', ({ attempt, maxRetries }) => {
  console.log(`Attempt ${attempt}/${maxRetries}`);
});

client.on('chunk', (text) => {
  process.stdout.write(text);
});

client.on('usage', (usage) => {
  console.log('\nTokens:', usage);
});

client.on('error', (error) => {
  console.error('Error:', error.message);
});

// Make request
const response = await client.complete(
  'claude-3-5-sonnet',
  [{ role: 'user', content: 'Hello!' }]
);
```

---

## Next Steps

- **[Python Examples](/api/completions/examples/python)** - See Python implementations
- **[curl Examples](/api/completions/examples/curl)** - Quick testing with curl
- **[Best Practices](/api/completions/best-practices)** - Production patterns
- **[Error Handling](/api/completions/errors)** - Handle errors properly
