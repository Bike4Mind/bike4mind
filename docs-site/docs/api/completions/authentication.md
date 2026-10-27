---
title: Authentication
description: Complete guide to API authentication and security for the B4M Completions API
sidebar_position: 2
---

# Authentication

Complete guide to authenticating with the B4M Completions API and securing your integration.

## Authentication Methods

The API supports **two authentication methods**, which are tried in this order:

### 1. API Key

Use an API key for production integrations and server-to-server communication. API keys provide fine-grained access control through scopes and rate limiting.

**Header formats:**

```bash
# Canonical
Authorization: Bearer b4m_live_xxxxxxxxxxxx

# Legacy, still accepted
X-API-Key: b4m_live_xxxxxxxxxxxx
```

`Authorization: ApiKey b4m_live_xxxxxxxxxxxx` is also accepted. A `Bearer` token that starts with `b4m_` is treated as an API key; anything else is treated as a JWT.

**Example request:**

```bash
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer b4m_live_xxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-5", "messages": [...]}'
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
  -d '{"model": "claude-sonnet-5", "messages": [...]}'
```

---

## Subscription access

Hosted API keys and CLI/desktop cloud access require an active paid subscription by default.
Paid standalone plans and organization seats qualify. An organization-billed key also qualifies
when its billing organization has a paid subscription. Administrators, developer-tagged users
and keys provisioned by an administrator are exempt from this access switch.

An administrator can change **Admin Settings > SecOps > API Rate Limiting > API Key Access**:
`all` opens access, `paid` requires a subscription, and `disabled` permits only the exemptions.
Self-hosted installations default to `all`. Changes apply within 30 seconds and also affect
existing keys and CLI/desktop sessions.

Federated apps using the AI-token exchange follow the same policy. A refused exchange returns
HTTP 403 with `error: "subscription_required"`, so your app can direct users to upgrade.

### Troubleshooting subscription access

If a valid key receives **"API keys require an active paid subscription"**, check your active
subscription and the administrator's access setting. Replacing the key does not change eligibility.
An organization-billed key must name the subscribed organization. A 5xx response means the server
could not complete verification; retry with backoff instead of discarding the credential.

## Obtaining an API Key

Follow these steps to create an API key:

### Step 1: Open API Keys

1. Log in to your B4M account
2. Open the **Profile** menu, then choose **More** -> **API Keys**
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
   |- Authorization: Bearer b4m_*
   |- X-API-Key (legacy)
   \- Authorization: ApiKey

2. If API key found:
   |- Validate key
   |- Check required scopes (ai:generate or ai:chat)
   |- Apply rate limiting
   \- Proceed to request

3. If no API key found:
   |- Check for JWT token
   |- Validate JWT
   \- Proceed to request

4. If neither found:
   \- Return 401 Unauthorized
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
  headers: { 'Authorization': `Bearer ${apiKey}` }
});
```

**✅ Good: Proxy through your backend**

```javascript
// Frontend code
fetch('/api/my-completion-proxy', {
  headers: { 'Authorization': `Bearer ${userJWT}` }
});

// Backend code (Node.js/Express)
import { Readable } from 'node:stream';

app.post('/api/my-completion-proxy', authenticateUser, async (req, res) => {
  // Validate user has permission
  if (!req.user.canUseAI) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Forward to B4M API with YOUR API key (server-side)
  const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.B4M_API_KEY}`, // Safe on server
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body)
  });

  // Stream response back to client
  res.status(response.status);
  res.setHeader('Content-Type', response.headers.get('content-type') ?? 'text/event-stream');
  Readable.fromWeb(response.body).pipe(res);
});
```

### Restrict API Key Usage by IP

If your application runs on a fixed set of servers, restrict API key usage to those IPs (feature availability may vary - contact support for details).

### Use Separate Keys for Environments

Use different API keys for each environment:

Create a separate key for production, staging and development, and name each one for its environment. All keys start with `b4m_live_`.

This way, if a development key is compromised, your production environment remains secure.

---

## Common Authentication Errors

### 401 Unauthorized

**Response body:**

```json
{ "error": "Authentication failed. Provide a valid API key or JWT token.", "request_id": "..." }
```

For some invalid keys the `error` text is more specific, for example `Invalid API key: <reason>`. Branch on the status, not the text.

**Causes:**
- Missing authentication header
- Invalid API key format
- Expired JWT token
- API key revoked

**Solutions:**
1. Verify API key is correctly set in environment variables
2. Check API key format (it should start with `b4m_live_`)
3. Ensure header format is correct (`Authorization: Bearer <key>`)
4. Regenerate API key if expired or revoked

### 403 Forbidden

**Response body:**

```json
{
  "error": "API key does not have permission for this endpoint (requires ai:chat or ai:generate)",
  "required_scopes": ["ai:chat", "ai:generate"],
  "request_id": "..."
}
```

**Causes:**
- API key missing required scopes (`ai:generate` or `ai:chat`); the body includes `required_scopes`
- If the body has no `required_scopes`, the account may be suspended or under a dispute; contact support. JWT requests can also be blocked by required MFA enrollment: complete enrollment in the web app. Changing key scopes does not resolve these account restrictions

**Solutions:**
1. Open the Profile menu -> More -> API Keys
2. Edit your API key
3. Add `ai:generate` or `ai:chat` scope
4. Save changes

---

## Authentication Testing

### Testing with curl

```bash
# Test authentication
curl -X POST https://app.bike4mind.com/api/ai/v1/completions \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  --no-buffer \
  -d '{
    "model": "claude-sonnet-5",
    "messages": [{"role": "user", "content": "test"}]
  }'
```

**Expected success:** SSE stream with content events

**Expected failure (invalid key):**
```
HTTP/1.1 401 Unauthorized
{"error":"Authentication failed. Provide a valid API key or JWT token.","request_id":"..."}
```

### Testing Programmatically

**JavaScript:**

```javascript
async function testAuth(apiKey) {
  try {
    const response = await fetch('https://app.bike4mind.com/api/ai/v1/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
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
                'Authorization': f"Bearer {api_key}",
                'Content-Type': 'application/json',
            },
            json={
                'model': 'claude-sonnet-5',
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

- **[API Reference](./reference.md)** - Complete technical specification
- **[SSE Streaming Guide](./streaming.md)** - Implement streaming
- **[Error Handling](./errors.md)** - Troubleshoot authentication issues
- **[Best Practices](./best-practices.md)** - Production security guidance
