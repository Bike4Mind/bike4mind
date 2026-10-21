---
title: Error Handling & Troubleshooting
description: Complete error reference and troubleshooting guide for the B4M Completions API
sidebar_position: 7
---

# Error Handling & Troubleshooting

Complete guide to handling errors and troubleshooting issues with the B4M Completions API.

## Error Format

All errors are returned as SSE error events:

```json
{
  "type": "error",
  "message": "Human-readable error description"
}
```

**Errors can occur at two stages:**

1. **Before streaming** - HTTP error status (401, 400, 429, 500, etc.)
2. **During streaming** - SSE error event in the stream

---

## HTTP Status Codes

| Status | Name | When It Happens |
|--------|------|-----------------|
| 200 | Success | Request accepted, SSE stream begins |
| 400 | Bad Request | Invalid request format or parameters |
| 401 | Unauthorized | Authentication failed (invalid API key/JWT) |
| 403 | Forbidden | Insufficient permissions or credits |
| 422 | Unprocessable Entity | Request validation failed (schema mismatch) |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server error (contact support if persistent) |

---

## Common Errors

### Authentication Errors

#### Error: Authentication failed

**Full message:** `"Authentication failed. Provide a valid API key or JWT token."`

**HTTP Code:** 401

**Causes:**
- Missing authentication header
- Invalid API key format
- Expired JWT token
- API key revoked

**Solutions:**
1. Verify API key is set correctly:
   ```bash
   echo $B4M_API_KEY  # Should print your key
   ```
2. Check API key format (should start with `b4m_live_` or `b4m_test_`)
3. Verify header format:
   ```bash
   X-API-Key: b4m_live_xxxxxxxxxxxx
   # OR
   Authorization: ApiKey b4m_live_xxxxxxxxxxxx
   # OR
   Authorization: Bearer b4m_live_xxxxxxxxxxxx
   ```
4. Regenerate API key if expired

---

#### Error: Invalid or expired token

**HTTP Code:** 401

**Causes:**
- JWT token expired
- JWT token invalid or malformed

**Solutions:**
1. Refresh your JWT token
2. Verify token hasn't been tampered with
3. Check token expiration time

---

#### Error: API key does not have permission

**Full message:** `"API key does not have permission for AI completions"`

**HTTP Code:** 403

**Causes:**
- API key missing required scopes (`ai:generate` or `ai:chat`)

**Solutions:**
1. Go to Settings → API Keys
2. Edit your API key
3. Add `ai:generate` or `ai:chat` scope
4. Save changes and use updated key

---

### Request Validation Errors

#### Error: Invalid request body

**HTTP Code:** 400 or 422

**Causes:**
- Malformed JSON
- Failed schema validation
- Missing required fields
- Invalid field types

**Solutions:**
1. Validate JSON syntax:
   ```bash
   echo '{"model": "claude-3-5-sonnet"}' | jq .
   ```
2. Verify required fields:
   - `model` (string)
   - `messages` (array)
3. Check field types match schema
4. Review [API Reference](/api/completions/reference) for correct format

---

#### Error: model is required

**HTTP Code:** 422

**Cause:** Missing `model` field in request

**Solution:**
```json
{
  "model": "claude-3-5-sonnet",  // Required
  "messages": [...]
}
```

---

#### Error: messages is required

**HTTP Code:** 422

**Cause:** Missing `messages` field in request

**Solution:**
```json
{
  "model": "claude-3-5-sonnet",
  "messages": [                    // Required
    {"role": "user", "content": "Hello"}
  ]
}
```

---

#### Error: Model info not found

**Full message:** `"Model info not found for '{model}'"`

**HTTP Code:** 400

**Causes:**
- Invalid model identifier
- Typo in model name
- Unsupported model

**Solutions:**
1. Verify model name spelling:
   ```json
   "model": "claude-3-5-sonnet"  // Correct
   "model": "claude-sonnet-3.5"  // Wrong
   ```
2. Use supported models:
   - `claude-3-5-sonnet`
   - `gpt-4`
   - `gpt-3.5-turbo`
   - Contact support for full model list

---

### Rate Limiting Errors

#### Error: Rate limit exceeded

**Full message:** `"Rate limit exceeded"` or `"Rate limit exceeded: {X} requests per minute allowed"`

**HTTP Code:** 429

**Headers:**
```http
Retry-After: 30
X-RateLimit-Remaining-Minute: 0
X-RateLimit-Reset-Minute: 1705334430
```

**Causes:**
- Too many requests in time window
- Per-minute limit hit
- Per-day limit hit

**Solutions:**

**1. Wait and retry**
```javascript
if (response.status === 429) {
  const retryAfter = response.headers.get('Retry-After') || 60;
  console.log(`Waiting ${retryAfter}s before retry...`);
  await sleep(retryAfter * 1000);
  // Retry request
}
```

**2. Check rate limit headers**
```javascript
const minuteRemaining = response.headers.get('X-RateLimit-Remaining-Minute');
const minuteReset = response.headers.get('X-RateLimit-Reset-Minute');

console.log(`${minuteRemaining} requests remaining`);
console.log(`Resets at ${new Date(minuteReset * 1000)}`);
```

**3. Implement client-side rate limiting**
```javascript
const limiter = new RateLimiter(60); // 60 requests/minute

await limiter.waitForSlot();
const response = await fetch(...);
```

**4. Request higher limits**

Contact support to increase your rate limits for production use.

---

### Credit/Billing Errors

#### Error: Insufficient credits

**Full message:** `"Insufficient credits. You have {X} credits, but this request requires approximately {Y} credits."`

**HTTP Code:** 403

**Causes:**
- Not enough credits in account balance
- Model requires more credits than available
- High `maxTokens` value increases cost estimate

**Solutions:**

**1. Add credits to account**
- Purchase additional credits
- Top up balance in billing settings

**2. Use cheaper model**
```json
// Expensive
"model": "gpt-4"

// Cheaper alternative
"model": "gpt-3.5-turbo"
```

**3. Reduce maxTokens**
```json
{
  "options": {
    "maxTokens": 500  // Lower limit = lower cost estimate
  }
}
```

**4. Monitor credit usage**
- Check usage analytics
- Set up billing alerts
- Track costs per request

---

### Model/LLM Errors

#### Error: Model response error

**Full message:** `"Model response error: {details}"`

**HTTP Code:** 500

**Causes:**
- LLM provider error
- Model temporarily unavailable
- Unexpected model response

**Solutions:**
1. Retry request after brief delay
2. Check provider status page
3. Try alternative model if available
4. Contact support if persistent

---

## Rate Limit Headers

All responses include rate limit information:

```http
X-RateLimit-Limit-Minute: 60
X-RateLimit-Remaining-Minute: 45
X-RateLimit-Reset-Minute: 1705334400

X-RateLimit-Limit-Day: 1000
X-RateLimit-Remaining-Day: 850
X-RateLimit-Reset-Day: 1705420800
```

### Understanding Rate Limit Headers

| Header | Description | Example |
|--------|-------------|---------|
| `X-RateLimit-Limit-Minute` | Max requests per minute | `60` |
| `X-RateLimit-Remaining-Minute` | Remaining this minute | `45` |
| `X-RateLimit-Reset-Minute` | Unix timestamp when resets | `1705334400` |
| `X-RateLimit-Limit-Day` | Max requests per day | `1000` |
| `X-RateLimit-Remaining-Day` | Remaining today | `850` |
| `X-RateLimit-Reset-Day` | Unix timestamp when resets | `1705420800` |

---

## Retry Strategies

### Exponential Backoff

Retry transient errors with exponential backoff:

```javascript
async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Success
      if (response.ok) {
        return response;
      }

      // Rate limited - wait and retry
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
        console.log(`Rate limited. Waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        continue;
      }

      // Server error - exponential backoff
      if (response.status >= 500) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        console.log(`Server error. Retrying in ${delay}ms...`);
        await sleep(delay);
        continue;
      }

      // Other errors - don't retry
      throw new Error(`HTTP ${response.status}`);

    } catch (error) {
      if (attempt === maxRetries - 1) throw error;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Retry Decision Matrix

| Error Code | Retryable? | Strategy |
|------------|------------|----------|
| 429 (Rate Limit) | ✅ Yes | Wait `Retry-After` seconds |
| 500 (Server Error) | ✅ Yes | Exponential backoff (max 3 attempts) |
| 503 (Service Unavailable) | ✅ Yes | Exponential backoff (max 3 attempts) |
| 401 (Unauthorized) | ❌ No | Fix authentication |
| 403 (Forbidden) | ❌ No | Fix permissions/credits |
| 400 (Bad Request) | ❌ No | Fix request format |
| 422 (Validation Error) | ❌ No | Fix request schema |

---

## Troubleshooting Guide

### Problem: Authentication Failing

**Symptoms:**
- HTTP 401 errors
- "Authentication failed" message

**Diagnosis:**
```bash
# Check API key is set
echo $B4M_API_KEY

# Test with curl
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"test"}]}'
```

**Solutions:**
1. Verify API key format (starts with `b4m_`)
2. Check API key hasn't expired
3. Regenerate key if needed
4. Verify scopes include `ai:generate` or `ai:chat`

---

### Problem: Rate Limits Being Hit

**Symptoms:**
- HTTP 429 errors
- "Rate limit exceeded" messages
- Requests failing during high traffic

**Diagnosis:**
```javascript
// Check rate limit headers
console.log('Minute remaining:', headers.get('X-RateLimit-Remaining-Minute'));
console.log('Day remaining:', headers.get('X-RateLimit-Remaining-Day'));
```

**Solutions:**
1. Implement client-side rate limiting
2. Add delays between requests
3. Queue requests instead of parallel execution
4. Request higher limits from support
5. Distribute load across multiple API keys (if allowed)

---

### Problem: Insufficient Credits

**Symptoms:**
- HTTP 403 errors
- "Insufficient credits" message
- Requests failing unexpectedly

**Diagnosis:**
```javascript
// Check error message for credit details
if (error.message.includes('Insufficient credits')) {
  const match = error.message.match(/have (\d+) credits.*requires.*(\d+) credits/);
  console.log(`Current: ${match[1]}, Required: ${match[2]}`);
}
```

**Solutions:**
1. Add credits to account
2. Switch to cheaper model
3. Reduce `maxTokens` parameter
4. Monitor credit usage patterns
5. Set up low balance alerts

---

### Problem: Stream Not Working

**Symptoms:**
- No real-time updates
- Entire response appears at once
- Long wait before output

**Diagnosis:**
```bash
# Test with curl (should stream)
curl --no-buffer -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Count to 10"}]}'
```

**Solutions:**
1. curl: Use `--no-buffer` flag
2. Python: Use `stream=True` in requests
3. JavaScript: Use `response.body.getReader()`
4. Check for buffering proxies
5. Verify `X-Accel-Buffering: no` header present

---

### Problem: JSON Parsing Errors

**Symptoms:**
- "Unexpected token" errors
- "Unexpected end of JSON" errors
- Parse failures in event handler

**Diagnosis:**
```javascript
try {
  const event = JSON.parse(data);
} catch (err) {
  console.error('Parse error:', err);
  console.error('Raw data:', data); // Log what failed
}
```

**Solutions:**
1. Buffer incomplete lines properly
2. Check for complete `data:` format
3. Wrap JSON.parse in try/catch
4. Split by `\n\n` for SSE boundaries
5. Handle `[DONE]` before parsing

---

### Problem: Missing Tool Calls

**Symptoms:**
- Expected `tool_use` event but got `content`
- Model doesn't call tools

**Diagnosis:**
```javascript
// Verify tools are included
console.log('Tools sent:', request.options.tools);

// Check model supports tools
const supportsTools = ['claude', 'gpt-4', 'gpt-3.5-turbo'].some(m =>
  model.includes(m)
);
```

**Solutions:**
1. Verify tools array included in request
2. Check tool descriptions are clear
3. Ensure `toolSchema.parameters` is valid JSON Schema
4. Try more explicit prompts
5. Verify model supports tools

---

## Error Logging Best Practices

### What to Log

```javascript
function logError(error, context) {
  console.error({
    timestamp: new Date().toISOString(),
    error: {
      message: error.message,
      stack: error.stack,
      status: error.status,
    },
    context: {
      model: context.model,
      messageCount: context.messages?.length,
      hasTools: Boolean(context.options?.tools),
    },
    rateLimit: {
      minuteRemaining: context.headers?.['x-ratelimit-remaining-minute'],
      dayRemaining: context.headers?.['x-ratelimit-remaining-day'],
    },
    // NEVER log: API key, message content, user data
  });
}
```

### What NOT to Log

❌ **Never log sensitive information:**
- API keys
- JWT tokens
- User message content
- Personal user data
- Credentials

---

## Getting Help

If you encounter persistent errors:

### 1. Check API Status

Verify the API is operational (status page coming soon).

### 2. Review Logs

Look for patterns:
- Same error repeatedly?
- Specific model causing issues?
- Time-based patterns?

### 3. Test with curl

Isolate client-side vs server-side issues:

```bash
curl -v --no-buffer -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"test"}]}'
```

### 4. Contact Support

Provide:
- Error messages (exact text)
- HTTP status codes
- Request timestamp
- Model used
- Steps to reproduce
- **Do NOT send:** API keys, user data

---

## Next Steps

- **[API Reference](/api/completions/reference)** - Verify request format
- **[Authentication](/api/completions/authentication)** - Fix auth issues
- **[Streaming Guide](/api/completions/streaming)** - Debug streaming problems
- **[Best Practices](/api/completions/best-practices)** - Production error handling
