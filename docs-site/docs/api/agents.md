# Agent API Reference

Complete API reference for Bike4Mind's AI agent system, including agent management, session integration, and real-time features.

## Base URL
```
https://app.bike4mind.com/api
```

## Authentication
Agent endpoints accept a JWT or a scoped API key:
```http
Authorization: Bearer <your-jwt-token>
```

## Agent Management Endpoints

`GET /api/agents` requires `agents:read` for API keys; create, update, delete and description generation require `agents:write`. JWT calls use the signed-in user's permissions. Session attachment endpoints below use the platform session API.

### List Agents

Get all agents accessible to the authenticated user.

```http
GET /agents
```

#### Query Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `query` | string | Search query for agent names | empty |
| `page` | number | Page number for pagination | 1 |
| `limit` | number | Number of agents per page | 10 |
| `orderBy` | string | `createdAt`, `updatedAt` or `name` | `updatedAt` |
| `orderDirection` | string | `asc` or `desc` | `desc` |

#### Response

```json
{
  "data": [
    {
      "_id": "665f1c2e9b1d4a0012ab34cd",
      "id": "665f1c2e9b1d4a0012ab34cd",
      "name": "Marketing Assistant",
      "description": "Helps with marketing content creation",
      "userId": "665f1c2e9b1d4a0012ab0001",
      "personality": {
        "majorMotivation": "Builder",
        "minorMotivation": "Helper",
        "flaw": "None",
        "quirk": "None"
      },
      "capabilities": ["{\"triggerWords\":[\"@marketing\"],\"responseStyle\":\"friendly\",\"specialBehaviors\":[]}"],
      "triggerWords": ["@marketing"],
      "isPublic": false,
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ],
  "hasMore": false,
  "total": 1
}
```

Agents you own include more fields than shown, such as `systemPrompt`, `visual`, `identity` and credit settings. Agents you do not own, including shared, organization and system agents, use a reduced response that omits `systemPrompt`, ownership fields and credit balances. The list is paged with `page` and `limit`; `hasMore` tells you whether another page exists and `total` is the number of matching agents.

### Create Agent

Create a new AI agent.

```http
POST /agents
```

#### Request Body

Only `name` is required. The API accepts these fields:

| Field | Notes |
|-------|-------|
| `name` | Required. |
| `description` | Optional. Defaults to `No description provided`. |
| `personality` | Object with `majorMotivation`, `minorMotivation`, `flaw`, `quirk` and `description`, plus further optional dimensions. Missing `flaw` and `quirk` default to `"None"`. |
| `triggerWords` | Array of strings. Defaults to `["@help"]`. |
| `capabilities` | Array holding one JSON string with `triggerWords`, `responseStyle` and `specialBehaviors`. See below. |
| `isPublic` | Boolean. Defaults to `false`. |
| `systemPrompt`, `preferredModel`, `temperature`, `maxTokens` | Optional model settings. |

`characterFlaw`, `uniqueQuirk` and a `personality.responseStyle` field are not read; send `flaw` and `quirk`, and set the response style inside `capabilities`.

`capabilities` is stored as a one-element array whose single entry is a JSON string, and the create call expects that same form. The string's `responseStyle` defaults to `"friendly"`.

```json
{
  "name": "My Custom Agent",
  "description": "A specialized agent for my use case",
  "personality": {
    "majorMotivation": "Explorer",
    "minorMotivation": "Analyzer",
    "flaw": "Impatient",
    "quirk": "Quotes Movies"
  },
  "capabilities": ["{\"triggerWords\":[\"@research\"],\"responseStyle\":\"casual\",\"specialBehaviors\":[]}"],
  "triggerWords": ["@research", "@analyze"],
  "isPublic": false
}
```

#### Response

Status `201`. The body is the created agent plus `userCredits`.

```json
{
  "_id": "665f1c2e9b1d4a0012ab34ce",
  "id": "665f1c2e9b1d4a0012ab34ce",
  "name": "My Custom Agent",
  "description": "A specialized agent for my use case",
  "userId": "665f1c2e9b1d4a0012ab0001",
  "personality": {
    "majorMotivation": "Explorer",
    "minorMotivation": "Analyzer",
    "flaw": "Impatient",
    "quirk": "Quotes Movies"
  },
  "capabilities": ["{\"triggerWords\":[\"@research\"],\"responseStyle\":\"casual\",\"specialBehaviors\":[]}"],
  "triggerWords": ["@research", "@analyze"],
  "isPublic": false,
  "userCredits": 1000
}
```

The object includes more fields than shown.

### Get Agent Details

Get detailed information about a specific agent.

```http
GET /agents/{agentId}
```

#### Response

```json
{
  "_id": "665f1c2e9b1d4a0012ab34cd",
  "id": "665f1c2e9b1d4a0012ab34cd",
  "name": "Marketing Assistant",
  "description": "Helps with marketing content creation",
  "userId": "665f1c2e9b1d4a0012ab0001",
  "personality": {
    "majorMotivation": "Builder",
    "minorMotivation": "Helper",
    "flaw": "None",
    "quirk": "None"
  },
  "capabilities": ["{\"triggerWords\":[\"@marketing\"],\"responseStyle\":\"friendly\",\"specialBehaviors\":[]}"],
  "triggerWords": ["@marketing"],
  "isPublic": false,
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-16T14:22:00.000Z"
}
```

The object includes more fields than shown.

### Update Agent

Update an existing agent (only owner can update).

```http
PUT /agents/{agentId}
```

#### Request Body

Send the fields you want to change. Field names match the create request. Nested objects such as `personality` and `visual` replace the stored object rather than merging with it; include every nested field you want to preserve.

```json
{
  "name": "Updated Marketing Assistant",
  "description": "Enhanced marketing content creation assistant",
  "personality": {
    "majorMotivation": "Builder",
    "minorMotivation": "Helper",
    "flaw": "Perfectionist",
    "quirk": "Loves Puns"
  },
  "triggerWords": ["@marketing", "@content", "@seo"],
  "isPublic": true
}
```

### Delete Agent

Delete an agent (only owner can delete).

```http
DELETE /agents/{agentId}
```

#### Response

Status `204` with an empty body. A later `GET /agents/{agentId}` returns `404`.

### Generate Agent Description

Use AI to generate a description based on agent personality and capabilities.

```http
POST /agents/{agentId}/generate-description
```

#### Response

```json
{
  "description": "A creative and helpful marketing assistant who loves to build engaging content."
}
```

## Session Agent Management

### Get Session Agents

Get all agents attached to a specific session.

```http
GET /sessions/{sessionId}/agents
```

#### Response

```json
{
  "agents": [
    {
      "id": "agent_123",
      "name": "Marketing Assistant",
      "description": "Helps with marketing content creation",
      "visual": { "portraitUrl": "https://example.com/avatar.png" }
    }
  ]
}
```

### Attach Agent to Session

Attach an agent to a conversation session.

```http
POST /sessions/{sessionId}/agents
```

#### Request Body

```json
{
  "agentId": "agent_123"
}
```

#### Response

```json
{ "session": { "id": "665f1c2e9b1d4a0012ab34ef", "agentIds": ["665f1c2e9b1d4a0012ab34cd"] } }
```

The response contains the updated session, with more fields than shown.

### Detach Agent from Session

Remove an agent from a conversation session.

```http
DELETE /sessions/{sessionId}/agents
```

#### Request Body

Send `agentId` in a JSON body, rather than the query string:

```json
{ "agentId": "665f1c2e9b1d4a0012ab34cd" }
```

#### Response

Both attach and detach return `{ "session": { ... } }`, containing the updated session. Getting session agents returns `{ "agents": [...] }` with full agent objects, in the same shape as the agent detail endpoint.

## WebSocket Events

Agents integrate with the real-time WebSocket system for live updates.

### Agent Attachment Events

```javascript
// Agent attached to session
{
  "type": "agent_attached",
  "sessionId": "session_123",
  "agent": {
    "id": "agent_456",
    "name": "Marketing Assistant",
    "avatarUrl": "https://..."
  },
  "timestamp": "2024-01-15T10:30:00Z"
}

// Agent detached from session
{
  "type": "agent_detached",
  "sessionId": "session_123", 
  "agentId": "agent_456",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Agent Response Events

```javascript
// Agent is contributing to response
{
  "type": "agent_thinking",
  "sessionId": "session_123",
  "agents": ["agent_456", "agent_789"],
  "timestamp": "2024-01-15T10:30:00Z"
}

// Agent response ready
{
  "type": "agent_response",
  "sessionId": "session_123",
  "messageId": "msg_123",
  "contributingAgents": [
    {
      "id": "agent_456",
      "name": "Marketing Assistant",
      "avatarUrl": "https://..."
    }
  ],
  "timestamp": "2024-01-15T10:30:00Z"
}
```

## Error Responses

All endpoints use standard HTTP status codes and return errors in this format:

```json
{
  "error": {
    "code": "AGENT_NOT_FOUND",
    "message": "The specified agent could not be found",
    "details": {
      "agentId": "agent_123"
    }
  },
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Common Error Codes

| Code | Status | Description |
|------|--------|-------------|
| `AGENT_NOT_FOUND` | 404 | Agent does not exist or is not accessible |
| `AGENT_ACCESS_DENIED` | 403 | User does not have permission to access agent |
| `AGENT_LIMIT_EXCEEDED` | 429 | User has exceeded agent creation limits |
| `INVALID_AGENT_DATA` | 400 | Request contains invalid agent data |
| `SESSION_NOT_FOUND` | 404 | Session does not exist or is not accessible |
| `AGENT_ALREADY_ATTACHED` | 409 | Agent is already attached to the session |
| `AGENT_NOT_ATTACHED` | 409 | Cannot detach agent that is not attached |

## Rate Limits

Agent API requests made with an API key use the standard per-key limits. Each key has a per-minute and a per-day limit, and exceeding either returns `429` with a `Retry-After` header in seconds. See [Rate limits and size](./completions/reference.md#rate-limits-and-size).

## Best Practices

### Agent Creation
- Use descriptive names and clear descriptions
- Choose personality traits that match the agent's intended purpose
- Include relevant capabilities to help with discovery
- Set appropriate public/private visibility

### Session Management  
- Attach agents before starting conversations for best performance
- Limit concurrent agents to 3-5 for optimal response quality
- Detach unused agents to improve performance

### Error Handling
- Always check for rate limit headers
- Implement exponential backoff for retries
- Handle agent access permissions gracefully
- Provide meaningful error messages to users

### Performance
- Cache agent data when possible
- Use pagination for large agent lists
- Monitor API usage to stay within rate limits
- Use WebSocket events for real-time updates