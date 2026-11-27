---
title: AI Completions API
description: Generate AI responses using state-of-the-art language models with real-time streaming
sidebar_position: 1
---

# AI Completions API

Generate AI responses using state-of-the-art language models with real-time streaming.

## What You Can Do

- **Stream responses in real-time** using Server-Sent Events (SSE)
- **Use multiple AI models** (Claude, GPT, Gemini, etc.)
- **Execute tools** with client-side function calling
- **Extended thinking** for complex reasoning tasks (Anthropic models)
- **Fine-grained control** over temperature, max tokens, and more

## Quick Example

Here's a simple request to get started:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ]
  }'
```

Model ids depend on which providers the deployment and your own provider keys enable. If this returns 400 `unknown_model` or 503 `provider_not_configured`, call `GET /api/v1/models` and use an id from that list.

**Response (SSE stream):**

```
data: {"type":"content","text":"Hello! How can I help you today?","usage":{"inputTokens":10,"outputTokens":9}}

data: [DONE]
```

## Use Cases

- **Chatbots and conversational AI** - Build interactive chat experiences
- **Code generation and assistance** - Generate, debug, and explain code
- **Content creation and editing** - Write articles, emails, and creative content
- **Data analysis and summarization** - Process and summarize large amounts of information
- **Research and information gathering** - Answer questions and explore topics

---

## Getting Started

Follow these steps to make your first successful request in 5 minutes.

### Prerequisites

You'll need an **API key** to authenticate your requests. If you don't have one yet, see the [Authentication](./authentication.md) guide to learn how to obtain an API key.

### Your First Request

Let's make a simple completion request using curl:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

**Important:** Replace `YOUR_API_KEY` with your actual B4M API key. Use the `--no-buffer` flag to see streaming output in real-time.

### Understanding the Response

The API returns a **Server-Sent Events (SSE)** stream. Each event has the format:

```
data: {JSON payload}

```

**Example response:**

```
data: {"type":"content","text":"2+2 equals 4.","usage":{"inputTokens":12,"outputTokens":7}}

data: [DONE]
```

**Response breakdown:**
- **`type: "content"`** - This is a content event (response text)
- **`text`** - The actual response from the model
- **`usage`** - Token usage for billing
  - `inputTokens`: Tokens in your request
  - `outputTokens`: Tokens in the response
- **`[DONE]`** - Signal that the stream is complete

### Request Format

The minimal request requires:

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Model identifier (e.g., `"claude-sonnet-5"`) |
| `messages` | array | Conversation history with role and content |

**Message structure:**

```json
{
  "role": "user" | "assistant" | "system",
  "content": "Your message text"
}
```

### Next Steps

Now that you've made your first request, explore more:

- **[Authentication](./authentication.md)** - Learn about API keys and security best practices
- **[API Reference](./reference.md)** - Complete technical specification
- **[SSE Streaming Guide](./streaming.md)** - Implement streaming in your application
- **[Code Examples](./examples/javascript.md)** - Production-ready code in JavaScript, Python, and more
- **[Tools & Function Calling](./tools.md)** - Add function calling to your requests
- **[Error Handling](./errors.md)** - Handle errors and troubleshoot issues
- **[Best Practices](./best-practices.md)** - Production deployment guidance

---

## Quick Links

### By Use Case

- **Building a chatbot?** -> Start with [SSE Streaming Guide](./streaming.md)
- **Need function calling?** -> See [Tools & Function Calling](./tools.md)
- **Complex reasoning tasks?** -> Check out [Extended Thinking](./extended-thinking.md)
- **Production deployment?** -> Read [Best Practices](./best-practices.md)

### By Language

- **JavaScript/TypeScript** -> [JavaScript Examples](./examples/javascript.md)
- **Python** -> [Python Examples](./examples/python.md)
- **curl** -> [curl Examples](./examples/curl.md)

---

## Support

If you encounter issues or have questions:

- **[Error Handling Guide](./errors.md)** - Troubleshoot common problems
- **API Status** - Check service status (coming soon)
- **Support** - Contact support for assistance (coming soon)
