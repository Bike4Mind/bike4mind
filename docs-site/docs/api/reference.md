# API Reference

Complete reference for all Bike4Mind API endpoints.

## Base Configuration

### API Structure
```
/api/
├── ai/                    # AI services and processing
├── users/                 # User management
├── organizations/         # Organization CRUD operations
├── api-keys/             # API key management
├── subscriptions/        # Billing and subscription management
├── analytics/            # Event tracking and analytics
├── [type]/[id]/          # Generic resource endpoints
└── utility endpoints     # Health checks, ping, etc.
```

### Base URL
```
https://app.bike4mind.com/api
```

### Authentication
All endpoints require authentication unless specified otherwise:
```http
Authorization: Bearer <jwt-token>
```

## AI Services API

### Audio Transcription
**POST** `/api/ai/transcribe`

Transcribe audio files using OpenAI Whisper.

**Request:**
- **Content-Type**: `multipart/form-data`
- **Body**: Audio file upload

**Response:**
```json
{
  "text": "Transcribed audio content"
}
```

**Example:**
```typescript
const formData = new FormData();
formData.append('file', audioFile);

const response = await fetch('/api/ai/transcribe', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`
  },
  body: formData
});
```

### Image Generation
**POST** `/api/ai/generate-image`

Generate images using AWS Bedrock.

**Request:**
```json
{
  "prompt": "A serene mountain landscape",
  "style": "photorealistic",
  "size": "1024x1024"
}
```

**Response:**
```json
{
  "questId": "quest_123",
  "status": "queued",
  "estimatedTime": 30
}
```

### LLM Inference
**POST** `/api/infer`

Direct LLM inference for text generation.

**Request:**
```json
{
  "model": "gpt-4",
  "messages": [
    {
      "role": "user",
      "content": "Explain quantum computing"
    }
  ],
  "stream": false
}
```

**Response:**
```json
{
  "result": "Quantum computing is a revolutionary approach..."
}
```

## User Management API

### Get User Profile
**GET** `/api/users/[id]`

Retrieve user profile information.

**Parameters:**
- `id`: User ID

**Response:**
```json
{
  "_id": "user_123",
  "username": "john_doe",
  "email": "john@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "organizationId": "org_456",
  "isAdmin": false,
  "preferences": {
    "theme": "dark",
    "language": "en"
  }
}
```

### List Users
**GET** `/api/users`

List users with filtering and pagination.

**Query Parameters:**
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)
- `search`: Search term
- `organizationId`: Filter by organization
- `role`: Filter by role

**Response:**
```json
{
  "users": [
    {
      "_id": "user_123",
      "username": "john_doe",
      "email": "john@example.com"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "pages": 3
  }
}
```

## Organization Management API

### List Organizations
**GET** `/api/organizations`

List organizations accessible to the user.

**Query Parameters:**
- `page`: Page number
- `limit`: Items per page
- `search`: Search term

**Response:**
```json
{
  "organizations": [
    {
      "_id": "org_123",
      "name": "Acme Corp",
      "slug": "acme-corp",
      "subscriptionTier": "pro",
      "memberCount": 15
    }
  ]
}
```

### Create Organization
**POST** `/api/organizations`

Create a new organization.

**Request:**
```json
{
  "name": "New Organization",
  "description": "Organization description"
}
```

**Response:**
```json
{
  "_id": "org_456",
  "name": "New Organization",
  "slug": "new-organization",
  "subscriptionStatus": "trial"
}
```

## API Key Management

### List API Keys
**GET** `/api/api-keys`

List user's API keys (obfuscated).

**Response:**
```json
{
  "apiKeys": [
    {
      "_id": "key_123",
      "name": "OpenAI Production",
      "service": "openai",
      "keyPreview": "sk-...xyz",
      "isActive": true,
      "lastUsedAt": "2024-01-15T10:30:00Z"
    }
  ]
}
```

### Delete API Key
**DELETE** `/api/api-keys/[id]/delete`

Delete an API key.

**Parameters:**
- `id`: API key ID

**Response:**
```json
{
  "success": true,
  "message": "API key deleted successfully"
}
```

### Set Active API Key
**POST** `/api/api-keys/[id]/set-active`

Set an API key as active for a service.

**Parameters:**
- `id`: API key ID

**Response:**
```json
{
  "success": true,
  "message": "API key set as active"
}
```

## Subscription Management

### Get User Subscriptions
**GET** `/api/subscriptions/own`

Get current user's subscriptions.

**Response:**
```json
{
  "subscriptions": [
    {
      "_id": "sub_123",
      "status": "active",
      "tier": "pro",
      "currentPeriodEnd": "2024-02-15T00:00:00Z",
      "creditsRemaining": 1500
    }
  ]
}
```

### List All Subscriptions (Admin)
**GET** `/api/subscriptions`

List all subscriptions (admin only).

**Query Parameters:**
- `search`: Search term
- `page`: Page number
- `limit`: Items per page

**Response:**
```json
{
  "subscriptions": [
    {
      "_id": "sub_123",
      "userId": "user_456",
      "organizationId": "org_789",
      "status": "active",
      "tier": "enterprise"
    }
  ],
  "pagination": {
    "total": 50,
    "page": 1,
    "pages": 5
  }
}
```

## Analytics & Tracking

### Log Event
**POST** `/api/analytics/log-event`

Track user events and analytics.

**Request:**
```json
{
  "event": "quest_completed",
  "properties": {
    "questId": "quest_123",
    "duration": 45000,
    "tokensUsed": 1250
  }
}
```

**Response:**
```http
204 No Content
```

## Generic Resource Endpoints

### Get Resource
**GET** `/api/[type]/[id]`

Generic endpoint for retrieving resources.

**Parameters:**
- `type`: Resource type (e.g., 'invite', 'project')
- `id`: Resource ID

**Example:**
```
GET /api/invite/inv_123
```

### Resource Invites
**GET** `/api/[type]/[id]/invites`

Get invites for a resource.

**POST** `/api/[type]/[id]/invites`

Create an invite for a resource.

### Revoke Sharing
**POST** `/api/[type]/[id]/revokeSharing`

Revoke sharing permissions for a resource.

## Utility Endpoints

### Health Check
**GET** `/api/ping`

Simple health check endpoint.

**Response:**
```json
{
  "message": "pong"
}
```

### Settings
**GET** `/api/settings/fetch`

Fetch user settings and preferences.

**Response:**
```json
{
  "theme": "dark",
  "language": "en", 
  "notifications": {
    "email": true,
    "slack": false
  }
}
```

## Pagination

### Standard Pagination
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "pages": 10,
    "hasNext": true,
    "hasPrev": false
  }
}
```

### Query Parameters
- `page`: Page number (1-based)
- `limit`: Items per page (max 100)
- `sort`: Sort field
- `order`: Sort order ('asc' or 'desc')

## WebSocket API

### Connection
```javascript
const ws = new WebSocket('wss://app.bike4mind.com/websocket');
```

### Message Format
```json
{
  "action": "subscribe_query",
  "data": {
    "query": "sessions",
    "filters": {
      "userId": "user_123"
    }
  }
}
```

### Supported Actions
- `subscribe_query`: Subscribe to data changes
- `unsubscribe_query`: Unsubscribe from data changes
- `heartbeat`: Keep connection alive