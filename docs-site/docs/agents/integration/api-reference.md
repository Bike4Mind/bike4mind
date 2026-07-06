---
title: Agent API Reference
description: Complete API reference for Bike4Mind agent endpoints
sidebar_position: 1
---

# Agent API Reference

This document provides a complete reference for all agent-related API endpoints in the Bike4Mind system.

## Authentication

All agent API endpoints require authentication via JWT tokens. Include the token in the Authorization header:

```
Authorization: Bearer <your-jwt-token>
```

## Base URL

```
https://app.bike4mind.com/api
```

## Agent Management Endpoints

### List Agents

Get all agents accessible to the authenticated user.

```http
GET /agents
```

#### Query Parameters

| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `search` | string | Search query for agent names | - |
| `owned` | boolean | Only return user-owned agents | false |
| `public` | boolean | Include public agents | true |
| `page` | number | Page number for pagination | 1 |
| `limit` | number | Number of agents per page | 20 |

#### Response

```json
{
  "agents": [
    {
      "id": "agent_123",
      "name": "Marketing Assistant",
      "description": "Helps with marketing content creation",
      "avatarUrl": "https://...",
      "personality": {
        "majorMotivation": "Builder",
        "minorMotivation": "Helper",
        "characterFlaw": "Perfectionist",
        "uniqueQuirk": "Loves Puns"
      },
      "capabilities": ["content_creation", "social_media"],
      "triggerWords": ["@marketing", "@content"],
      "isPublic": true,
      "ownerId": "user_456",
      "createdAt": "2024-01-15T10:30:00Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

### Create Agent

Create a new AI agent.

```http
POST /agents
```

#### Request Body

```json
{
  "name": "My Custom Agent",
  "description": "A specialized agent for my use case",
  "personality": {
    "majorMotivation": "Explorer",
    "minorMotivation": "Analyzer",
    "characterFlaw": "Impatient",
    "uniqueQuirk": "Quotes Movies",
    "responseStyle": "casual"
  },
  "capabilities": ["research", "analysis"],
  "triggerWords": ["@research", "@analyze"],
  "isPublic": false,
  "avatarUrl": "https://example.com/avatar.png"
}
```

#### Response

```json
{
  "id": "agent_789",
  "name": "My Custom Agent",
  "description": "A specialized agent for my use case",
  "avatarUrl": "https://example.com/avatar.png",
  "personality": {
    "majorMotivation": "Explorer",
    "minorMotivation": "Analyzer",
    "characterFlaw": "Impatient",
    "uniqueQuirk": "Quotes Movies",
    "responseStyle": "casual"
  },
  "capabilities": ["research", "analysis"],
  "triggerWords": ["@research", "@analyze"],
  "isPublic": false,
  "ownerId": "user_current",
  "createdAt": "2024-01-15T10:30:00Z"
}
```

### Get Agent Details

Get detailed information about a specific agent.

```http
GET /agents/{agentId}
```

#### Response

```json
{
  "id": "agent_123",
  "name": "Marketing Assistant",
  "description": "Helps with marketing content creation",
  "avatarUrl": "https://...",
  "personality": {
    "majorMotivation": "Builder",
    "minorMotivation": "Helper",
    "characterFlaw": "Perfectionist",
    "uniqueQuirk": "Loves Puns",
    "responseStyle": "friendly"
  },
  "capabilities": ["content_creation", "social_media"],
  "triggerWords": ["@marketing", "@content"],
  "isPublic": true,
  "ownerId": "user_456",
  "createdAt": "2024-01-15T10:30:00Z",
  "updatedAt": "2024-01-16T14:22:00Z"
}
```

### Update Agent

Update an existing agent (only owner can update).

```http
PUT /agents/{agentId}
```

#### Request Body

```json
{
  "name": "Updated Marketing Assistant",
  "description": "Enhanced marketing content creation assistant",
  "personality": {
    "majorMotivation": "Builder",
    "minorMotivation": "Helper",
    "characterFlaw": "Perfectionist", 
    "uniqueQuirk": "Loves Puns",
    "responseStyle": "professional"
  },
  "capabilities": ["content_creation", "social_media", "seo"],
  "triggerWords": ["@marketing", "@content", "@seo"],
  "isPublic": true
}
```

### Delete Agent

Delete an agent (only owner can delete).

```http
DELETE /agents/{agentId}/delete
```

#### Response

```json
{
  "message": "Agent deleted successfully",
  "deletedAt": "2024-01-15T10:30:00Z"
}
```

### Generate Agent Description

Use AI to generate a description based on agent personality and capabilities.

```http
POST /agents/{agentId}/generate-description
```

#### Response

```json
{
  "description": "A creative and helpful marketing assistant who loves to build engaging content. Known for their perfectionist tendencies and love of puns, they bring both professionalism and humor to every project.",
  "generatedAt": "2024-01-15T10:30:00Z"
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
      "avatarUrl": "https://...",
      "attachedAt": "2024-01-15T10:30:00Z"
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
{
  "message": "Agent attached successfully",
  "agent": {
    "id": "agent_123",
    "name": "Marketing Assistant",
    "avatarUrl": "https://..."
  },
  "attachedAt": "2024-01-15T10:30:00Z"
}
```

### Detach Agent from Session

Remove an agent from a conversation session.

```http
DELETE /sessions/{sessionId}/agents
```

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agentId` | string | Yes | ID of the agent to detach |

#### Response

```json
{
  "message": "Agent detached successfully",
  "detachedAt": "2024-01-15T10:30:00Z"
}
```

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

Agent API endpoints are subject to rate limiting:

| Endpoint Pattern | Limit | Window |
|------------------|-------|--------|
| `GET /agents` | 100 requests | 1 minute |
| `POST /agents` | 10 requests | 1 minute |
| `PUT /agents/*` | 30 requests | 1 minute |
| `DELETE /agents/*` | 10 requests | 1 minute |
| `*/sessions/*/agents` | 60 requests | 1 minute |

Rate limit information is included in response headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1642284600
```

## SDKs and Examples

### JavaScript/TypeScript

```typescript
import { BikeForMindClient } from '@bike4mind/sdk';

const client = new BikeForMindClient({
  apiKey: 'your-api-key',
  baseUrl: 'https://app.bike4mind.com'
});

// Create an agent
const agent = await client.agents.create({
  name: 'My Assistant',
  description: 'A helpful assistant',
  personality: {
    majorMotivation: 'Helper',
    responseStyle: 'friendly'
  },
  capabilities: ['general_assistance']
});

// Attach to session
await client.sessions.attachAgent(sessionId, agent.id);
```

### Python

```python
from bike4mind import BikeForMindClient

client = BikeForMindClient(
    api_key='your-api-key',
    base_url='https://app.bike4mind.com'
)

# Create an agent
agent = client.agents.create(
    name='My Assistant',
    description='A helpful assistant',
    personality={
        'major_motivation': 'Helper',
        'response_style': 'friendly'
    },
    capabilities=['general_assistance']
)

# Attach to session
client.sessions.attach_agent(session_id, agent['id'])
```

### cURL Examples

```bash
# Create an agent
curl -X POST https://app.bike4mind.com/api/agents \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Research Assistant",
    "description": "Helps with research tasks",
    "personality": {
      "majorMotivation": "Explorer",
      "responseStyle": "analytical"
    },
    "capabilities": ["research", "analysis"]
  }'

# Attach agent to session
curl -X POST https://app.bike4mind.com/api/sessions/session_123/agents \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agentId": "agent_456"}'
```

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

---

For more examples and detailed integration guides, see the [Integration section](../integration/). 