---
title: API Reference
description: Complete technical specification for the B4M Completions API
sidebar_position: 3
---

# API Reference

Complete technical specification for the B4M AI Completions API.

## Endpoint

```
POST https://app.bike4mind.com/api/ai/v1/completions
```

---

## Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | Must be `application/json` |
| `X-API-Key` or `Authorization` | Yes | Authentication credentials (see [Authentication](/api/completions/authentication)) |

**Example:**

```http
POST /api/ai/v1/completions HTTP/1.1
Host: app.bike4mind.com
Content-Type: application/json
X-API-Key: b4m_live_xxxxxxxxxxxx
```

---

## Request Body

The request body must be valid JSON matching this schema:

```typescript
{
  model: string;              // Required. Model identifier
  messages: Array<Message>;   // Required. Conversation history
  options?: {                 // Optional configuration
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    tools?: Array<Tool>;
  };
}
```

### Parameters

#### `model` (required)

**Type:** `string`

**Description:** The identifier of the AI model to use for completion.

**Examples:**
- `"claude-3-5-sonnet"` - Anthropic Claude 3.5 Sonnet
- `"gpt-4"` - OpenAI GPT-4
- `"gpt-3.5-turbo"` - OpenAI GPT-3.5 Turbo
- `"gemini-pro"` - Google Gemini Pro

```json
{
  "model": "claude-3-5-sonnet"
}
```

---

#### `messages` (required)

**Type:** `Array<Message>`

**Description:** Array of conversation messages forming the context for the completion.

**Message structure:**

```typescript
interface Message {
  role: "user" | "assistant" | "system";
  content: string | Array<ContentBlock>;
}
```

**Roles:**
- `"user"` - Messages from the user/human
- `"assistant"` - Messages from the AI assistant (for multi-turn conversations)
- `"system"` - System instructions that guide the assistant's behavior

**Content types:**
- **String:** Simple text content
- **Array:** Multimodal content with text, images, or tool results

**Example (simple text):**

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant that explains things clearly."
    },
    {
      "role": "user",
      "content": "What is photosynthesis?"
    }
  ]
}
```

**Example (multi-turn conversation):**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "What's the capital of France?"
    },
    {
      "role": "assistant",
      "content": "The capital of France is Paris."
    },
    {
      "role": "user",
      "content": "What's its population?"
    }
  ]
}
```

**Example (multimodal content with images):**

```json
{
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "What's in this image?"
        },
        {
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": "image/jpeg",
            "data": "base64-encoded-image-data"
          }
        }
      ]
    }
  ]
}
```

---

#### `options` (optional)

**Type:** `object`

**Description:** Optional parameters to control the completion behavior.

---

#### `options.temperature` (optional)

**Type:** `number`

**Default:** Model-specific default (typically 1.0)

**Range:** 0.0 to 1.0

**Description:** Controls randomness in the output. Higher values make output more random, lower values make it more focused and deterministic.

**Recommendations:**
- **0.0-0.3:** Factual responses, code generation, data extraction
- **0.4-0.7:** Balanced responses, general chat, Q&A
- **0.8-1.0:** Creative writing, brainstorming, storytelling

```json
{
  "options": {
    "temperature": 0.7
  }
}
```

---

#### `options.maxTokens` (optional)

**Type:** `number`

**Default:** 4096

**Range:** 1 to model-specific maximum

**Description:** Maximum number of tokens to generate in the completion. The response will be truncated if this limit is reached.

**Note:** Setting appropriate limits helps control costs and prevents unexpectedly long responses.

```json
{
  "options": {
    "maxTokens": 1024
  }
}
```

---

#### `options.stream` (optional)

**Type:** `boolean`

**Default:** `true`

**Description:** Enable streaming responses via Server-Sent Events (SSE). Currently, this API always streams, so this parameter has no effect.

```json
{
  "options": {
    "stream": true
  }
}
```

---

#### `options.tools` (optional)

**Type:** `Array<Tool>`

**Description:** Array of tool definitions that the model can choose to call. See [Tools & Function Calling](/api/completions/tools) for complete documentation.

**Tool structure:**

```typescript
interface Tool {
  toolSchema: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}
```

**Example:**

```json
{
  "options": {
    "tools": [
      {
        "toolSchema": {
          "name": "get_weather",
          "description": "Get current weather for a specific location",
          "parameters": {
            "type": "object",
            "properties": {
              "location": {
                "type": "string",
                "description": "City name (e.g., 'San Francisco')"
              }
            },
            "required": ["location"]
          }
        }
      }
    ]
  }
}
```

---

## Response Format

**Content-Type:** `text/event-stream`

**Description:** The API returns a Server-Sent Events (SSE) stream containing completion events.

### Response Headers

All responses include these headers:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

**Rate limiting headers** (included on all responses):

```http
X-RateLimit-Limit-Minute: 60
X-RateLimit-Remaining-Minute: 45
X-RateLimit-Reset-Minute: 1705334400
X-RateLimit-Limit-Day: 1000
X-RateLimit-Remaining-Day: 850
X-RateLimit-Reset-Day: 1705420800
```

### SSE Event Format

Each event is formatted as:

```
data: {JSON}\n\n
```

**Example stream:**

```
data: {"type":"content","text":"Hello","usage":{"inputTokens":10,"outputTokens":5}}

data: {"type":"content","text":" world!","usage":{"inputTokens":10,"outputTokens":10}}

data: [DONE]

```

### Event Types

#### Content Event

**Type:** `content`

**Description:** Regular completion response containing text.

**Structure:**

```typescript
{
  type: "content";
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  thinking?: Array<ThinkingBlock>;  // Anthropic extended thinking
}
```

**Example:**

```json
{
  "type": "content",
  "text": "The capital of France is Paris.",
  "usage": {
    "inputTokens": 150,
    "outputTokens": 80
  }
}
```

---

#### Tool Use Event

**Type:** `tool_use`

**Description:** The model wants to call one or more tools. Contains tool call requests that the client must execute.

**Structure:**

```typescript
{
  type: "tool_use";
  text: string;
  tools: Array<{
    name: string;
    arguments: string;  // JSON string of the tool input
    id: string;         // Unique ID for pairing with tool_result
  }>;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  thinking?: Array<ThinkingBlock>;
}
```

**Example:**

```json
{
  "type": "tool_use",
  "text": "Let me check the weather for you.",
  "tools": [
    {
      "name": "get_weather",
      "arguments": "{\"location\":\"San Francisco\"}",
      "id": "toolu_01ABC123"
    }
  ],
  "usage": {
    "inputTokens": 120,
    "outputTokens": 65
  }
}
```

**Important:** The `arguments` field is a JSON string that you must parse. The `id` field must be used when sending `tool_result` back to pair the result with the correct tool call.

**What to do:** Execute the tools locally and send results back in the next request. See [Tools & Function Calling](/api/completions/tools) for the complete workflow.

---

#### Error Event

**Type:** `error`

**Description:** An error occurred during processing.

**Structure:**

```typescript
{
  type: "error";
  message: string;
}
```

**Example:**

```json
{
  "type": "error",
  "message": "Insufficient credits. You have 50 credits, but this request requires approximately 150 credits."
}
```

**What to do:** Handle the error appropriately. See [Error Handling](/api/completions/errors) for detailed guidance.

---

#### Completion Signal

**Format:** `data: [DONE]`

**Description:** Signals that the stream is complete and no more events will be sent.

**Example:**

```
data: [DONE]

```

**What to do:** Close the connection and process the complete response.

---

## Rate Limiting

The API enforces rate limits to ensure fair usage and system stability.

### Rate Limit Headers

Every response includes rate limit information:

| Header | Description | Example |
|--------|-------------|---------|
| `X-RateLimit-Limit-Minute` | Maximum requests allowed per minute | `60` |
| `X-RateLimit-Remaining-Minute` | Remaining requests this minute | `45` |
| `X-RateLimit-Reset-Minute` | Unix timestamp when minute limit resets | `1705334400` |
| `X-RateLimit-Limit-Day` | Maximum requests allowed per day | `1000` |
| `X-RateLimit-Remaining-Day` | Remaining requests today | `850` |
| `X-RateLimit-Reset-Day` | Unix timestamp when daily limit resets | `1705420800` |

### Rate Limit Exceeded

When you exceed your rate limit:

**HTTP Status:** `429 Too Many Requests`

**Headers:**

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Remaining-Minute: 0
X-RateLimit-Reset-Minute: 1705334430
```

**Response:**

```json
{
  "type": "error",
  "message": "Rate limit exceeded: 60 requests per minute allowed"
}
```

**What to do:**
1. Wait for the time specified in the `Retry-After` header (in seconds)
2. Retry your request after the wait period
3. Implement exponential backoff for repeated rate limits

See [Best Practices - Rate Limit Management](/api/completions/best-practices#rate-limit-management) for implementation guidance.

---

## Credit System

The API uses a credit-based billing system to manage costs.

### How It Works

**1. Pre-flight Reservation**

Before processing your request, the API reserves credits based on estimated cost:

```
Estimated Cost = (Estimated Input Tokens + maxTokens) × Model Price
```

**Token estimation:**
- Input tokens: Estimated at 2.5 characters per token
- Output tokens: Uses `maxTokens` parameter (default: 4096)

If you have insufficient credits, the request fails immediately with a 403 error.

**2. Execution**

Your request is processed by the LLM, and actual token usage is measured.

**3. Adjustment**

After completion, credits are adjusted based on actual usage:

- **Over-reserved:** Excess credits are refunded
- **Under-reserved:** Additional credits are charged (rare)

All transactions are logged for audit purposes.

### Credit Calculation

Credits are calculated from USD cost:

```
USD Cost = (Input Tokens × Input Price) + (Output Tokens × Output Price)
Credits = USD Cost × 100
```

**Example calculation (GPT-4):**

```
Input: 150 tokens × $0.03/1K = $0.0045
Output: 80 tokens × $0.06/1K = $0.0048
Total USD: $0.0093
Total Credits: 0.93 ≈ 1 credit
```

### Insufficient Credits Error

**HTTP Status:** `403 Forbidden`

**Response:**

```json
{
  "type": "error",
  "message": "Insufficient credits. You have 50 credits, but this request requires approximately 150 credits."
}
```

**Solutions:**
1. Add credits to your account
2. Use a cheaper model (e.g., `gpt-3.5-turbo` instead of `gpt-4`)
3. Reduce `maxTokens` to lower estimated cost
4. Monitor credit usage with analytics (coming soon)

---

## Complete Example

Here's a complete example showing all components:

**Request:**

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: b4m_live_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant."
      },
      {
        "role": "user",
        "content": "Explain quantum computing in one sentence."
      }
    ],
    "options": {
      "temperature": 0.7,
      "maxTokens": 100
    }
  }'
```

**Response (SSE stream):**

```
data: {"type":"content","text":"Quantum computing uses quantum mechanical phenomena like superposition and entanglement to process information in ways that classical computers cannot, potentially solving certain complex problems exponentially faster.","usage":{"inputTokens":45,"outputTokens":38}}

data: [DONE]

```

**Response breakdown:**
- **Event type:** `content` - Regular text response
- **Text:** Complete answer in one sentence as requested
- **Usage:** 45 input tokens (your request) + 38 output tokens (response)
- **[DONE]:** Stream completed successfully

---

## HTTP Status Codes

| Status Code | Name | Meaning |
|-------------|------|---------|
| 200 | Success | Request accepted, SSE stream begins |
| 400 | Bad Request | Invalid request format or parameters |
| 401 | Unauthorized | Authentication failed (invalid API key or JWT) |
| 403 | Forbidden | Insufficient permissions or credits |
| 422 | Unprocessable Entity | Request validation failed (schema mismatch) |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server error (contact support if persistent) |

---

## Next Steps

- **[SSE Streaming Guide](/api/completions/streaming)** - Learn how to implement streaming in your application
- **[Tools & Function Calling](/api/completions/tools)** - Add function calling to your requests
- **[Extended Thinking](/api/completions/extended-thinking)** - Use Anthropic's reasoning feature
- **[Error Handling](/api/completions/errors)** - Handle errors and troubleshoot issues
- **[Code Examples](/api/completions/examples/javascript)** - See production-ready implementations
- **[Best Practices](/api/completions/best-practices)** - Production deployment guidance
