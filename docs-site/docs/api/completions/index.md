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
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "Hello, world!"}
    ]
  }'
```

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

You'll need an **API key** to authenticate your requests. If you don't have one yet, see the [Authentication](/api/completions/authentication) guide to learn how to obtain an API key.

### Your First Request

Let's make a simple completion request using curl:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
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
| `model` | string | Model identifier (e.g., `"claude-3-5-sonnet"`) |
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

- **[Authentication](/api/completions/authentication)** - Learn about API keys and security best practices
- **[API Reference](/api/completions/reference)** - Complete technical specification
- **[SSE Streaming Guide](/api/completions/streaming)** - Implement streaming in your application
- **[Code Examples](/api/completions/examples/javascript)** - Production-ready code in JavaScript, Python, and more
- **[Tools & Function Calling](/api/completions/tools)** - Add function calling to your requests
- **[Error Handling](/api/completions/errors)** - Handle errors and troubleshoot issues
- **[Best Practices](/api/completions/best-practices)** - Production deployment guidance

---

## Quick Links

### By Use Case

- **Building a chatbot?** → Start with [SSE Streaming Guide](/api/completions/streaming)
- **Need function calling?** → See [Tools & Function Calling](/api/completions/tools)
- **Complex reasoning tasks?** → Check out [Extended Thinking](/api/completions/extended-thinking)
- **Production deployment?** → Read [Best Practices](/api/completions/best-practices)

### By Language

- **JavaScript/TypeScript** → [JavaScript Examples](/api/completions/examples/javascript)
- **Python** → [Python Examples](/api/completions/examples/python)
- **curl** → [curl Examples](/api/completions/examples/curl)

---

## Support

If you encounter issues or have questions:

- **[Error Handling Guide](/api/completions/errors)** - Troubleshoot common problems
- **API Status** - Check service status (coming soon)
- **Support** - Contact support for assistance (coming soon)
