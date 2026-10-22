---
title: curl Examples
description: Quick curl examples for testing the B4M Completions API
sidebar_position: 3
---

# curl Examples

Quick curl command examples for testing the B4M Completions API from the command line.

## Prerequisites

Set your API key as an environment variable:

```bash
export B4M_API_KEY="b4m_live_xxxxxxxxxxxx"
```

:::tip
Always use `--no-buffer` flag to see streaming output in real-time.
:::

---

## Basic Request

Simple completion request:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

**Expected output:**

```
data: {"type":"content","text":"Hello! How can I help you today?","usage":{"inputTokens":10,"outputTokens":9}}

data: [DONE]
```

---

## With Options

Request with temperature and maxTokens:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "Write a short poem"}
    ],
    "options": {
      "temperature": 0.8,
      "maxTokens": 200
    }
  }'
```

---

## Multi-turn Conversation

Request with conversation history:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "What is the capital of France?"},
      {"role": "assistant", "content": "The capital of France is Paris."},
      {"role": "user", "content": "What is its population?"}
    ]
  }'
```

---

## With System Message

Request with system instructions:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {
        "role": "system",
        "content": "You are a helpful assistant that explains things in simple terms."
      },
      {
        "role": "user",
        "content": "Explain quantum computing"
      }
    ]
  }'
```

---

## With Tools

Request with tool definitions:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [
      {"role": "user", "content": "What is the weather in London?"}
    ],
    "options": {
      "tools": [
        {
          "toolSchema": {
            "name": "get_weather",
            "description": "Get weather for a location",
            "parameters": {
              "type": "object",
              "properties": {
                "location": {
                  "type": "string",
                  "description": "City name"
                }
              },
              "required": ["location"]
            }
          }
        }
      ]
    }
  }'
```

---

## Alternative Authentication Headers

### Using Authorization: ApiKey

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: ApiKey $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Using Authorization: Bearer

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## Debugging with Verbose Output

Show full HTTP request and response headers:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -v \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Verbose output includes:**
- Request headers
- Response headers (including rate limits)
- HTTP status code
- SSL/TLS information

---

## Filtering Output

### Show only data lines

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Count to 5"}]
  }' | grep "^data:"
```

### Show only HTTP headers

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -v \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' 2>&1 | grep -E "^(< |> )"
```

### Pretty-print JSON events with jq

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' | while IFS= read -r line; do
    if [[ $line == data:* ]]; then
      data="${line#data: }"
      if [[ $data != "[DONE]" ]]; then
        echo "$data" | jq .
      fi
    fi
  done
```

---

## Save Output to File

Save complete response to file:

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Write a story"}]
  }' > response.txt
```

---

## Testing Different Models

### Claude 3.5 Sonnet

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### GPT-4

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### GPT-3.5 Turbo

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type": application/json" \
  --no-buffer \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

---

## Error Testing

### Test with invalid API key

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: invalid_key" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Expected:** HTTP 401 Unauthorized

### Test with invalid model

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "invalid-model",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**Expected:** HTTP 400 Bad Request

### Test with missing required field

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet"
  }'
```

**Expected:** HTTP 422 Unprocessable Entity (missing messages)

---

## Performance Testing

### Measure response time

```bash
time curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' > /dev/null
```

### Measure time to first byte

```bash
curl -w "Time to first byte: %{time_starttransfer}s\n" \
  -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello!"}]
  }' > /dev/null
```

---

## Useful curl Options

| Option | Description | Example |
|--------|-------------|---------|
| `--no-buffer` | Disable output buffering (required for streaming) | `curl --no-buffer ...` |
| `-v` | Verbose output (show headers) | `curl -v ...` |
| `-s` | Silent mode (hide progress) | `curl -s ...` |
| `-o file` | Save output to file | `curl -o response.txt ...` |
| `-w format` | Custom output format | `curl -w "%{http_code}\n" ...` |
| `-H header` | Add custom header | `curl -H "X-API-Key: ..." ...` |
| `-d data` | Send POST data | `curl -d '{"key":"value"}' ...` |
| `-X method` | Specify HTTP method | `curl -X POST ...` |

---

## Common Issues

### Problem: No streaming output

**Symptom:** Entire response appears at once instead of streaming

**Solution:** Always use `--no-buffer` flag:

```bash
curl --no-buffer ...  # Required for streaming
```

### Problem: Binary characters in output

**Symptom:** Strange characters appear in terminal

**Solution:** This is normal for SSE. Use `grep` or `jq` to filter:

```bash
curl ... | grep "^data:" | sed 's/^data: //'
```

### Problem: SSL certificate errors

**Symptom:** `SSL certificate problem`

**Solution:** Use `-k` to skip certificate verification (development only):

```bash
curl -k ...  # Skip SSL verification (insecure, dev only)
```

---

## Next Steps

- **[JavaScript Examples](/api/completions/examples/javascript)** - Implement in JavaScript
- **[Python Examples](/api/completions/examples/python)** - Implement in Python
- **[Best Practices](/api/completions/best-practices)** - Production patterns
- **[Streaming Guide](/api/completions/streaming)** - Detailed streaming documentation
