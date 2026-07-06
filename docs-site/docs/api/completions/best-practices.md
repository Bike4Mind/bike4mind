---
title: Best Practices
description: Production deployment guidance for the B4M Completions API
sidebar_position: 8
---

# Best Practices

Production deployment guidance for the B4M Completions API, covering security, performance, reliability, and cost optimization.

## Security

### Never Expose API Keys Client-Side

**❌ Bad: Client-side code with API key**

```javascript
// Frontend code (NEVER DO THIS)
const apiKey = 'b4m_live_xxxxxxxxxxxx'; // Exposed to users!

fetch('https://app.bike4mind.com/api/ai/v1/completions', {
  headers: { 'X-API-Key': apiKey }
});
```

**✅ Good: Proxy through your backend**

```javascript
// Frontend code
fetch('/api/my-completion-proxy', {
  headers: { 'Authorization': `Bearer ${userJWT}` }
});

// Backend code (Node.js/Express)
app.post('/api/my-completion-proxy', authenticateUser, async (req, res) => {
  // Validate user has permission
  if (!req.user.canUseAI) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Forward to B4M API with YOUR API key (server-side)
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'X-API-Key': process.env.B4M_API_KEY, // Safe on server
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body)
  });

  // Stream response back to client
  response.body.pipe(res);
});
```

### Use Environment Variables

Store API keys in environment variables, never in code:

**Node.js:**
```javascript
const apiKey = process.env.B4M_API_KEY;
```

**Python:**
```python
import os
api_key = os.environ.get("B4M_API_KEY")
```

**Docker:**
```bash
docker run -e B4M_API_KEY=b4m_live_xxx myapp
```

### Rotate Keys Regularly

**Recommended schedule:**
- Production: Every 90 days
- Development: Every 180 days
- Immediately after: suspected compromise, team member departure

**Rotation process:**
1. Generate new API key
2. Update application configuration
3. Deploy and test
4. Revoke old key
5. Monitor for errors

### Use Separate Keys per Environment

```
Production:  b4m_live_production_xxx
Staging:     b4m_test_staging_xxx
Development: b4m_test_dev_xxx
```

**Benefits:**
- Limit blast radius of compromises
- Easier tracking and debugging
- Independent rate limits per environment

---

## Rate Limit Management

### Monitor Rate Limits Proactively

Check rate limit headers on every response:

```javascript
function checkRateLimits(headers) {
  const minuteRemaining = parseInt(headers.get('x-ratelimit-remaining-minute') || '0');
  const minuteLimit = parseInt(headers.get('x-ratelimit-limit-minute') || '60');
  const minuteUsage = ((minuteLimit - minuteRemaining) / minuteLimit) * 100;

  if (minuteUsage > 80) {
    console.warn(`Rate limit warning: ${minuteUsage.toFixed(0)}% of minute quota used`);
  }

  // Alert if approaching daily limit
  const dayRemaining = parseInt(headers.get('x-ratelimit-remaining-day') || '0');
  if (dayRemaining < 100) {
    console.warn(`Daily limit warning: ${dayRemaining} requests remaining`);
  }
}
```

### Implement Client-Side Rate Limiting

Prevent hitting server-side limits:

```javascript
class RateLimiter {
  constructor(requestsPerMinute) {
    this.requestsPerMinute = requestsPerMinute;
    this.requests = [];
  }

  async waitForSlot() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove old requests
    this.requests = this.requests.filter(time => time > oneMinuteAgo);

    if (this.requests.length >= this.requestsPerMinute) {
      const oldestRequest = this.requests[0];
      const waitTime = 60000 - (now - oldestRequest);

      console.log(`Rate limit: waiting ${Math.ceil(waitTime / 1000)}s`);

      await new Promise(resolve => setTimeout(resolve, waitTime));

      return this.waitForSlot(); // Try again
    }

    this.requests.push(now);
  }
}

const limiter = new RateLimiter(60);

async function makeRequest() {
  await limiter.waitForSlot();
  return fetch(...);
}
```

### Use Request Queuing

Queue requests during high traffic:

```javascript
class RequestQueue {
  constructor(maxConcurrent = 5) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
  }

  async add(requestFn) {
    if (this.running >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }

    this.running++;

    try {
      return await requestFn();
    } finally {
      this.running--;

      if (this.queue.length > 0) {
        const resolve = this.queue.shift();
        resolve();
      }
    }
  }
}

const queue = new RequestQueue(5); // Max 5 concurrent requests

async function makeQueuedRequest(messages) {
  return queue.add(() => client.complete('claude-3-5-sonnet', messages));
}
```

---

## Credit Optimization

### Choose Appropriate Models

Balance cost vs quality for your use case:

| Model | Cost | Best For |
|-------|------|----------|
| `gpt-3.5-turbo` | $ | Simple Q&A, classification, quick responses |
| `claude-3-5-sonnet` | $$ | Balanced quality and cost, general use |
| `gpt-4` | $$$ | Complex reasoning, critical accuracy |
| `claude-3-opus` | $$$$ | Most capable, highest quality |

**Example strategy:**

```javascript
function selectModel(taskComplexity) {
  switch (taskComplexity) {
    case 'simple':
      return 'gpt-3.5-turbo';
    case 'moderate':
      return 'claude-3-5-sonnet';
    case 'complex':
      return 'gpt-4';
    case 'critical':
      return 'claude-3-opus';
    default:
      return 'claude-3-5-sonnet';
  }
}
```

### Set Reasonable maxTokens

Avoid over-reserving credits:

```javascript
// Bad: Unlimited or very high limits
{ maxTokens: 100000 }

// Good: Appropriate for task
const maxTokens = {
  shortAnswer: 500,
  codeGeneration: 2000,
  essay: 4000,
  conversation: 1024,
};
```

### Cache Responses

Cache identical requests:

```javascript
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getCachedCompletion(prompt) {
  const cacheKey = JSON.stringify(prompt);
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log('Cache hit');
    return cached.response;
  }

  const response = await complete(prompt);

  cache.set(cacheKey, {
    response,
    timestamp: Date.now()
  });

  return response;
}
```

### Monitor Credit Usage

Track usage patterns:

```javascript
let totalTokensUsed = 0;
let totalCreditsUsed = 0;

function trackUsage(event) {
  if (event.usage) {
    const inputTokens = event.usage.inputTokens || 0;
    const outputTokens = event.usage.outputTokens || 0;
    totalTokensUsed += inputTokens + outputTokens;

    // Estimate credits (varies by model)
    const estimatedCredits = (inputTokens + outputTokens) * 0.001;
    totalCreditsUsed += estimatedCredits;

    console.log({
      totalTokens: totalTokensUsed,
      estimatedCredits: totalCreditsUsed.toFixed(2)
    });
  }
}
```

---

## Error Handling

### Always Handle All Event Types

```javascript
function handleEvent(event) {
  switch (event.type) {
    case 'content':
      // Display content
      displayContent(event.text);
      break;

    case 'tool_use':
      // Execute tools
      executeTools(event.tools);
      break;

    case 'error':
      // Handle error
      handleError(event.message);
      break;

    default:
      // Log unknown types for future compatibility
      console.warn('Unknown event type:', event.type);
      logUnknownEvent(event);
  }
}
```

### Implement Exponential Backoff

Retry transient errors with backoff:

```javascript
async function fetchWithBackoff(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      if (response.ok) return response;

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

### Log Errors Properly

Log enough for debugging, but not sensitive data:

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

---

## Tool Execution

### Validate Tool Inputs

Never trust tool inputs from the model:

```javascript
function validateToolInput(toolName, input) {
  const schemas = {
    get_weather: {
      location: (val) => typeof val === 'string' && val.length > 0 && val.length < 100
    },
    search_database: {
      query: (val) => typeof val === 'string' && val.length > 0,
      limit: (val) => typeof val === 'number' && val > 0 && val <= 100
    }
  };

  const schema = schemas[toolName];
  if (!schema) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  for (const [field, validator] of Object.entries(schema)) {
    if (!validator(input[field])) {
      throw new Error(`Invalid ${field} for tool ${toolName}`);
    }
  }
}
```

### Set Timeouts

Don't let tool execution hang:

```javascript
async function executeToolWithTimeout(toolName, toolInput, timeoutMs = 5000) {
  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('Tool execution timeout')), timeoutMs);
  });

  const executionPromise = executeTool(toolName, toolInput);

  try {
    return await Promise.race([executionPromise, timeoutPromise]);
  } catch (error) {
    return {
      error: true,
      message: `Tool '${toolName}' timed out after ${timeoutMs}ms`
    };
  }
}
```

### Whitelist Tools

Only allow execution of explicitly defined tools:

```javascript
const ALLOWED_TOOLS = new Set(['get_weather', 'search_database']);

function executeTool(toolName, toolInput) {
  if (!ALLOWED_TOOLS.has(toolName)) {
    throw new Error(`Tool ${toolName} not allowed`);
  }

  // Validate inputs
  validateToolInput(toolName, toolInput);

  // Execute tool
  switch (toolName) {
    case 'get_weather':
      return getWeather(toolInput.location);
    case 'search_database':
      return searchDatabase(toolInput.query, toolInput.limit);
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
```

---

## Performance

### Stream Responses to Users

Display content as it arrives:

```javascript
client.streamCompletion(model, messages, null, (event) => {
  if (event.type === 'content') {
    updateUI(event.text); // Update immediately (better UX)
  }
});
```

### Use Connection Pooling

Reuse HTTP connections:

```javascript
import https from 'https';

const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  keepAliveMsecs: 30000
});

fetch(url, { agent });
```

### Implement Request Deduplication

Avoid duplicate concurrent requests:

```javascript
const pendingRequests = new Map();

async function deduplicatedRequest(key, fetchFn) {
  if (pendingRequests.has(key)) {
    console.log('Deduplicating request:', key);
    return pendingRequests.get(key);
  }

  const promise = fetchFn();
  pendingRequests.set(key, promise);

  try {
    return await promise;
  } finally {
    pendingRequests.delete(key);
  }
}

// Usage
const response = await deduplicatedRequest(
  `completion:${JSON.stringify(messages)}`,
  () => client.complete('claude-3-5-sonnet', messages)
);
```

### Monitor Latency

Track request performance:

```javascript
async function timedRequest(url, options) {
  const start = Date.now();

  try {
    const response = await fetch(url, options);
    const duration = Date.now() - start;

    console.log({
      duration_ms: duration,
      status: response.status,
      url: url
    });

    return response;

  } catch (err) {
    const duration = Date.now() - start;
    console.error({
      duration_ms: duration,
      error: err.message,
      url: url
    });
    throw err;
  }
}
```

---

## Production Checklist

Before deploying to production, ensure:

### Security
- [ ] API keys stored securely (environment variables, secrets manager)
- [ ] API keys never exposed client-side
- [ ] Server-side proxy implemented for web apps
- [ ] Key rotation schedule established
- [ ] Separate keys for each environment
- [ ] Security review completed

### Rate Limiting
- [ ] Client-side rate limiting implemented
- [ ] Rate limit headers monitored
- [ ] Alerts configured for approaching limits
- [ ] Request queuing implemented
- [ ] Fallback strategy for rate limits

### Error Handling
- [ ] Exponential backoff retry logic in place
- [ ] All event types handled
- [ ] Error logging configured
- [ ] Alerts configured for error spikes
- [ ] Graceful degradation implemented

### Cost Management
- [ ] Credit usage monitoring set up
- [ ] Appropriate models selected
- [ ] maxTokens limits configured
- [ ] Response caching implemented (if applicable)
- [ ] Budget alerts configured

### Tool Execution
- [ ] Tool inputs validated
- [ ] Timeouts configured
- [ ] Whitelist implemented
- [ ] Error handling in place
- [ ] Security review of tool execution

### Performance
- [ ] Connection pooling enabled
- [ ] Request deduplication implemented
- [ ] Latency monitoring set up
- [ ] Streaming implemented for UX
- [ ] Load testing completed

### Reliability
- [ ] Health checks implemented
- [ ] Monitoring and alerting configured
- [ ] Rollback plan prepared
- [ ] Documentation for team members
- [ ] On-call runbook created

### Testing
- [ ] Unit tests passing
- [ ] Integration tests passing
- [ ] Load tests passing
- [ ] Error scenarios tested
- [ ] Tool calling tested end-to-end

---

## Monitoring & Alerting

### Key Metrics to Track

**Request Metrics:**
- Requests per minute/hour/day
- Success rate (%)
- Error rate (%)
- Average latency (ms)
- P95/P99 latency (ms)

**Credit Metrics:**
- Credits used per hour/day
- Cost per request
- Token usage (input/output)
- Model distribution

**Rate Limit Metrics:**
- Rate limit utilization (%)
- Rate limit violations count
- Time spent waiting for rate limits

**Error Metrics:**
- Error rate by type
- 4xx vs 5xx errors
- Retry success rate
- Timeout rate

### Example Monitoring Setup

```javascript
class MetricsCollector {
  constructor() {
    this.metrics = {
      requests: 0,
      errors: 0,
      tokens: 0,
      credits: 0,
      latencies: [],
      rateLimitWaits: 0
    };
  }

  recordRequest(duration, success, tokens, credits) {
    this.metrics.requests++;
    this.metrics.latencies.push(duration);

    if (!success) this.metrics.errors++;
    if (tokens) this.metrics.tokens += tokens;
    if (credits) this.metrics.credits += credits;

    // Report to monitoring service
    this.report();
  }

  recordRateLimitWait() {
    this.metrics.rateLimitWaits++;
  }

  report() {
    // Send to monitoring service (Datadog, Prometheus, etc.)
    console.log({
      timestamp: Date.now(),
      requests: this.metrics.requests,
      errorRate: (this.metrics.errors / this.metrics.requests * 100).toFixed(2) + '%',
      avgLatency: this.avg(this.metrics.latencies).toFixed(0) + 'ms',
      totalTokens: this.metrics.tokens,
      totalCredits: this.metrics.credits.toFixed(2),
      rateLimitWaits: this.metrics.rateLimitWaits
    });
  }

  avg(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length || 0;
  }
}

const metrics = new MetricsCollector();
```

---

## Next Steps

- **[API Reference](/api/completions/reference)** - Review complete API spec
- **[Error Handling](/api/completions/errors)** - Handle errors properly
- **[Code Examples](/api/completions/examples/javascript)** - See implementations
- **[Authentication](/api/completions/authentication)** - Secure API keys
