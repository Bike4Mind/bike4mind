---
title: Authentication
description: Complete guide to API authentication and security for the B4M Completions API
sidebar_position: 2
---

# Authentication

Complete guide to authenticating with the B4M Completions API and securing your integration.

## Authentication Methods

The API supports **two authentication methods**, which are tried in this order:

### 1. API Key (Recommended)

Use an API key for production integrations and server-to-server communication. API keys provide fine-grained access control through scopes and rate limiting.

**Header formats** (any of these work):

```bash
# Option 1: X-API-Key header (recommended)
X-API-Key: b4m_live_xxxxxxxxxxxx

# Option 2: Authorization with ApiKey prefix
Authorization: ApiKey b4m_live_xxxxxxxxxxxx

# Option 3: Authorization with Bearer prefix (if key starts with b4m_)
Authorization: Bearer b4m_live_xxxxxxxxxxxx
```

**Example request:**

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: b4m_live_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet", "messages": [...]}'
```

### 2. JWT Token (Fallback)

Use JWT tokens for user-context requests where you need to authenticate on behalf of a specific user.

**Header format:**

```bash
Authorization: Bearer <jwt-token>
```

**Example request:**

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet", "messages": [...]}'
```

---

## Obtaining an API Key

Follow these steps to create an API key:

### Step 1: Navigate to API Keys Settings

1. Log in to your B4M account
2. Go to **Settings** → **API Keys**
3. Click **Create API Key**

### Step 2: Configure API Key

**Name your key:**
- Give it a descriptive name (e.g., "Production API", "Development Server")
- This helps you identify keys later

**Select required scopes:**

The API requires **at least one** of these scopes:

| Scope | Description |
|-------|-------------|
| `ai:generate` | Full AI generation capabilities (recommended) |
| `ai:chat` | Chat-specific operations |

**Configure rate limits:**

Set appropriate rate limits for your use case:
- **Requests per minute** - Limit short-term burst traffic
- **Requests per day** - Control daily usage

### Step 3: Save and Secure Your Key

1. Click **Create**
2. **Copy your API key immediately** - it's only shown once
3. Store it securely (see [Security Best Practices](#security-best-practices) below)

:::warning Important
API keys are shown **only once** during creation. If you lose your key, you'll need to create a new one.
:::

---

## Required Scopes

Your API key must have at least one of these scopes:

### `ai:generate`

Full AI generation capabilities. **Recommended** for most use cases.

**Grants access to:**
- AI completions
- All model types
- Tool calling
- Extended thinking

### `ai:chat`

Chat-specific operations.

**Grants access to:**
- Chat-based completions
- Conversational AI features

---

## Authentication Flow

The API checks authentication in this order:

```
1. Check for API key in headers
   ├─ X-API-Key header
   ├─ Authorization: ApiKey
   └─ Authorization: Bearer b4m_*

2. If API key found:
   ├─ Validate key
   ├─ Check required scopes (ai:generate or ai:chat)
   ├─ Apply rate limiting
   └─ Proceed to request

3. If no API key found:
   ├─ Check for JWT token
   ├─ Validate JWT
   └─ Proceed to request

4. If neither found:
   └─ Return 401 Unauthorized
```

---

## Security Best Practices

### Never Commit API Keys to Version Control

**❌ Bad:**

```javascript
// config.js
export const API_KEY = 'b4m_live_xxxxxxxxxxxx'; // DON'T DO THIS
```

**✅ Good:**

```javascript
// config.js
export const API_KEY = process.env.B4M_API_KEY;
```

Add API keys to `.gitignore`:

```
# .gitignore
.env
.env.local
.env.production
```

### Use Environment Variables

Store API keys in environment variables, never in code.

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

**Example .env file:**

```bash
# .env
B4M_API_KEY=b4m_live_xxxxxxxxxxxx
```

### Rotate Keys Regularly

1. Generate a new API key
2. Update your application to use the new key
3. Test thoroughly
4. Revoke the old key

**Recommended rotation schedule:**
- Production: Every 90 days
- Development: Every 180 days
- Immediately after: suspected compromise, team member departure

### Monitor Usage for Anomalies

Regularly check your API usage for unexpected patterns:

- **Unusual request volume** - Spike in requests
- **Failed authentication attempts** - Possible key compromise
- **Requests from unexpected IPs** - Unauthorized usage
- **Rate limit violations** - Potential abuse

### Use Minimal Required Scopes

Grant only the scopes your application needs:

**❌ Bad:** Granting all scopes "just in case"

**✅ Good:** Only granting `ai:generate` if that's all you need

This principle of least privilege limits damage if a key is compromised.

### Implement Server-Side Proxy

**Never expose API keys in client-side code.** Instead, proxy requests through your backend.

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

### Restrict API Key Usage by IP

If your application runs on a fixed set of servers, restrict API key usage to those IPs (feature availability may vary - contact support for details).

### Use Separate Keys for Environments

Use different API keys for each environment:

- **Production:** `b4m_live_xxxxxxxxxxxx`
- **Staging:** `b4m_test_xxxxxxxxxxxx`
- **Development:** `b4m_test_xxxxxxxxxxxx`

This way, if a development key is compromised, your production environment remains secure.

---

## Common Authentication Errors

### 401 Unauthorized

**Error message:** `"Authentication failed. Provide a valid API key or JWT token."`

**Causes:**
- Missing authentication header
- Invalid API key format
- Expired JWT token
- API key revoked

**Solutions:**
1. Verify API key is correctly set in environment variables
2. Check API key format (should start with `b4m_live_` or `b4m_test_`)
3. Ensure header format is correct (`X-API-Key: <key>`)
4. Regenerate API key if expired or revoked

### 403 Forbidden

**Error message:** `"API key does not have permission for AI completions"`

**Causes:**
- API key missing required scopes (`ai:generate` or `ai:chat`)

**Solutions:**
1. Go to Settings → API Keys
2. Edit your API key
3. Add `ai:generate` or `ai:chat` scope
4. Save changes

---

## Authentication Testing

### Testing with curl

```bash
# Test authentication
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "X-API-Key: $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "test"}]
  }'
```

**Expected success:** SSE stream with content events

**Expected failure (invalid key):**
```
HTTP/1.1 401 Unauthorized
{"type":"error","message":"Authentication failed. Provide a valid API key or JWT token."}
```

### Testing Programmatically

**JavaScript:**

```javascript
async function testAuth(apiKey) {
  try {
    const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    if (response.ok) {
      console.log('✓ Authentication successful');
    } else {
      console.error(`✗ Authentication failed: ${response.status}`);
    }
  } catch (err) {
    console.error('✗ Request failed:', err);
  }
}

testAuth(process.env.B4M_API_KEY);
```

**Python:**

```python
import os
import requests

def test_auth(api_key):
    try:
        response = requests.post(
            'https://app.bike4mind.com/api/ai/v1/completions',
            headers={
                'X-API-Key': api_key,
                'Content-Type': 'application/json',
            },
            json={
                'model': 'claude-3-5-sonnet',
                'messages': [{'role': 'user', 'content': 'test'}]
            },
            stream=True
        )

        if response.ok:
            print('✓ Authentication successful')
        else:
            print(f'✗ Authentication failed: {response.status_code}')
    except Exception as e:
        print(f'✗ Request failed: {e}')

test_auth(os.environ.get('B4M_API_KEY'))
```

---

## Next Steps

- **[API Reference](/api/completions/reference)** - Complete technical specification
- **[SSE Streaming Guide](/api/completions/streaming)** - Implement streaming
- **[Error Handling](/api/completions/errors)** - Troubleshoot authentication issues
- **[Best Practices](/api/completions/best-practices)** - Production security guidance
