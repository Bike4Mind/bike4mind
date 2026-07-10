// brand externalized
import { getBrandName } from '@client/config/general';

export const API_REFERENCE_CONTENT = `
# ${getBrandName()} API Reference

Complete API documentation for ${getBrandName()}, a cognitive workbench platform. All endpoints are served from \`https://your-deployment.example.com\` (production) or \`https://staging.your-deployment.example.com\` (staging).

---

## Authentication

${getBrandName()} supports two authentication methods: JWT bearer tokens and API keys.

### JWT Bearer Token

Include the token in the \`Authorization\` header:

\`\`\`
Authorization: Bearer <access_token>
\`\`\`

| Token Type | Lifetime | Description |
|------------|----------|-------------|
| Access Token | 7 days | Short-lived token for API requests |
| Refresh Token | 30 days | Used to obtain new access tokens |

**Obtaining tokens:**

- \`POST /api/otc/send\` — request a one-time sign-in code by email (passwordless)
- \`POST /api/otc/verify\` — verify the code to log in or register; returns both tokens
- \`POST /api/auth/refreshToken\` — exchange a refresh token for a new access token
- OAuth callbacks (Google, GitHub, Okta, SAML) return tokens on successful authentication

### API Key Authentication

API keys use the \`b4m_live_\` prefix and can be passed via either header:

\`\`\`
X-API-Key: b4m_live_xxxxx
\`\`\`

or

\`\`\`
Authorization: ApiKey b4m_live_xxxxx
\`\`\`

**Managing API keys:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/user-api-keys | List your API keys |
| POST | /api/api-keys/create | Create a new API key |
| POST | /api/user-api-keys/[id]/rotate | Rotate an existing key |
| POST | /api/user-api-keys/[id]/revoke | Revoke a key |
| POST | /api/api-keys/[id]/set-active | Activate/deactivate a key |
| DELETE | /api/api-keys/[id]/delete | Delete a key |

### Scopes

API keys can be scoped to limit access. Available scopes:

| Scope | Description |
|-------|-------------|
| \`notebooks:read\` | Read sessions/notebooks |
| \`notebooks:write\` | Create, update, delete sessions |
| \`files:read\` | Read and download files |
| \`files:write\` | Upload, chunk, delete files |
| \`projects:read\` | Read projects and members |
| \`projects:write\` | Create, update, delete projects |
| \`ai:generate\` | Use image/video/audio generation endpoints |
| \`ai:chat\` | Send chat messages and use LLM endpoints |
| \`admin:*\` | Full admin access (superuser only) |

### Rate Limits

| Limit | Default |
|-------|---------|
| Requests per minute | 60 |
| Requests per day | 1,000 |

Rate limit headers are included in every response:

\`\`\`
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1700000000
\`\`\`

When rate-limited, the API returns \`429 Too Many Requests\`.

---

## Core API Domains

### Chat / Quest (Agentic AI)

The primary conversational AI interface. Messages are sent via \`/api/chat\` and processed asynchronously. Poll the quest endpoint for the AI response.

#### Send a Message

\`\`\`
POST /api/chat
\`\`\`

**Required API-key scope:** \`ai:chat\` or \`ai:generate\` (either grants access).

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| message | string | Yes | The user message content |
| sessionId | string | No | Session ID to continue a conversation (creates new session if omitted) |
| model | string | No | LLM model identifier (e.g., \`gpt-4o\`, \`claude-sonnet-4-20250514\`) |
| temperature | number | No | Sampling temperature (0.0 - 2.0, default 0.7) |
| stream | boolean | No | Enable streaming response via WebSocket |
| tools | string[] | No | Tool names to enable for this request |
| agentId | string | No | Agent ID to use for this conversation |
| fileIds | string[] | No | File IDs to attach as context |
| projectId | string | No | Project ID for RAG grounding |

**Response:**

\`\`\`json
{
  "questId": "quest_abc123",
  "sessionId": "sess_xyz789",
  "status": "pending"
}
\`\`\`

#### Poll Quest Status

\`\`\`
GET /api/quests/[id]
\`\`\`

**Required API-key scope:** \`notebooks:read\`, \`ai:chat\`, or \`ai:generate\` (any one grants access — an AI scope works so the chat→poll flow needs a single key).

**Response:**

\`\`\`json
{
  "id": "quest_abc123",
  "status": "completed",
  "reply": {
    "content": "Here is the AI response...",
    "model": "gpt-4o",
    "tokensUsed": { "input": 150, "output": 320 },
    "sources": [],
    "artifacts": []
  },
  "createdAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:05Z"
}
\`\`\`

#### Get Quest Files

\`\`\`
GET /api/quests/[id]/files
\`\`\`

**Required API-key scope:** \`notebooks:read\`, \`ai:chat\`, or \`ai:generate\` (any one grants access — an AI scope works so the chat→poll flow needs a single key).

Returns files generated or referenced during quest processing.

#### Stop a Reply

\`\`\`
POST /api/sessions/[id]/chat/stop-reply
\`\`\`

Cancels an in-progress streaming response.

#### Chat Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/chat | Send a message to the AI |
| GET | /api/quests/[id] | Get quest status and reply |
| GET | /api/quests/[id]/files | Get files from a quest |
| GET | /api/quests/[id]/check-timeout | Check if quest has timed out |
| POST | /api/quests/[id]/client-timing | Report client-side timing data |
| POST | /api/sessions/[id]/chat/stop-reply | Cancel streaming response |
| POST | /api/sessions/[id]/chat/[messageId]/fork | Fork conversation from a message |
| POST | /api/sessions/[id]/chat/[messageId]/snip | Snip conversation at a message |
| GET | /api/sessions/[id]/chat/[messageId] | Get a specific message |
| POST | /api/infer | Raw inference endpoint |

---

### Files (FabFiles)

Manage uploaded files, trigger chunking for RAG, and search file content.

#### List Files

\`\`\`
GET /api/files
\`\`\`

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| page | number | Page number (default 1) |
| limit | number | Items per page (default 20, max 100) |
| search | string | Search by filename |
| tags | string | Comma-separated tag filter |
| projectId | string | Filter by project |
| sort | string | Sort field (e.g., \`createdAt\`, \`name\`) |
| order | string | Sort order: \`asc\` or \`desc\` |

**Response:**

\`\`\`json
{
  "files": [
    {
      "id": "file_abc123",
      "name": "quarterly-report.pdf",
      "size": 1048576,
      "mimeType": "application/pdf",
      "tags": ["reports", "Q4"],
      "chunked": true,
      "chunkCount": 24,
      "projectId": "proj_xyz",
      "createdAt": "2025-01-10T08:00:00Z",
      "updatedAt": "2025-01-10T08:05:00Z"
    }
  ],
  "total": 142,
  "page": 1,
  "limit": 20
}
\`\`\`

#### Upload a File

\`\`\`
POST /api/files/createFabFileURL
\`\`\`

Returns a presigned S3 URL for direct upload.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| fileName | string | Yes | Original filename |
| contentType | string | Yes | MIME type |
| projectId | string | No | Associate with a project |

#### Trigger Chunking

\`\`\`
POST /api/files/chunk
\`\`\`

Initiates the chunking and embedding pipeline for a file.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| fileId | string | Yes | File ID to chunk |

#### File Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/files | List files with pagination and filters |
| GET | /api/files/[id] | Get file details |
| PUT | /api/files/[id] | Update file metadata |
| DELETE | /api/files/[id] | Delete a file |
| POST | /api/files/createFabFileURL | Get presigned upload URL |
| POST | /api/files/createFabFile | Create file record |
| POST | /api/files/chunk | Trigger chunking pipeline |
| GET | /api/files/search | Full-text search across file content |
| POST | /api/files/bulk-delete | Delete multiple files |
| GET | /api/files/byIds | Get multiple files by ID |
| POST | /api/files/copy-generated-image | Copy AI-generated image to files |
| GET | /api/files/download | Download file content |
| POST | /api/files/generate-presigned-url | Generate download URL |
| POST | /api/files/generate-smart-name | AI-generated filename |
| GET | /api/files/getFabFileNameById | Get filename by ID |
| GET | /api/files/presigned-url | Get presigned URL |
| GET | /api/files/tags | List all tags |
| GET | /api/files/tags/counts | Tag usage counts |
| POST | /api/files/tags/toggle | Toggle tag on a file |
| PUT | /api/files/tags/[id] | Update a tag |

---

### Sessions (Notebooks)

Sessions represent conversations/notebooks. They are created implicitly when sending a chat message without a sessionId, or explicitly.

#### List Sessions

\`\`\`
GET /api/sessions
\`\`\`

**Query Parameters:**

| Param | Type | Description |
|-------|------|-------------|
| page | number | Page number |
| limit | number | Items per page |
| search | string | Search by title |
| projectId | string | Filter by project |
| tags | string | Filter by tags |
| sort | string | Sort field |

**Response:**

\`\`\`json
{
  "sessions": [
    {
      "id": "sess_abc123",
      "title": "Quarterly Analysis Discussion",
      "messageCount": 12,
      "model": "gpt-4o",
      "projectId": "proj_xyz",
      "tags": ["analysis"],
      "isFavorite": false,
      "createdAt": "2025-01-15T10:00:00Z",
      "updatedAt": "2025-01-15T11:30:00Z"
    }
  ],
  "total": 87,
  "page": 1,
  "limit": 20
}
\`\`\`

#### Session Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/sessions | List sessions |
| POST | /api/sessions/create | Create a new session |
| GET | /api/sessions/[id] | Get session details |
| PUT | /api/sessions/[id] | Update session |
| DELETE | /api/sessions/[id] | Delete session |
| POST | /api/sessions/[id]/clone | Clone a session |
| POST | /api/sessions/[id]/auto-rename | AI-generated session title |
| POST | /api/sessions/[id]/favorite | Toggle favorite |
| POST | /api/sessions/[id]/tag | Add/remove tags |
| GET | /api/sessions/[id]/files | List session files |
| GET | /api/sessions/[id]/summary | Get session summary |
| GET | /api/sessions/[id]/agents | List agents in session |
| POST | /api/sessions/[id]/agents/trigger-proactive-messages | Trigger proactive agent messages |
| GET | /api/sessions/[id]/agents/configs | Get agent configs for session |
| PUT | /api/sessions/[id]/agents/[agentId]/config | Update agent config |
| GET | /api/sessions/[id]/questmaster-plans | Get QuestMaster plans |
| POST | /api/sessions/bulk | Bulk operations on sessions |
| GET | /api/sessions/count | Get total session count |
| GET | /api/sessions/favorites | List favorited sessions |
| GET | /api/sessions/shared | List shared sessions |
| GET | /api/sessions/download | Export session as file |
| GET | /api/sessions/semantic-search | Semantic search across sessions |
| GET | /api/sessions/recent-proactive-messages | Recent proactive messages |

---

### Projects

Projects organize files, sessions, and team members into workspaces.

#### List Projects

\`\`\`
GET /api/projects
\`\`\`

**Response:**

\`\`\`json
{
  "projects": [
    {
      "id": "proj_abc123",
      "name": "Market Research Q1",
      "description": "Research project for Q1 market analysis",
      "fileCount": 15,
      "sessionCount": 8,
      "memberCount": 3,
      "createdAt": "2025-01-05T09:00:00Z"
    }
  ],
  "total": 12
}
\`\`\`

#### Project Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/projects | List projects |
| POST | /api/projects | Create a project |
| GET | /api/projects/[id] | Get project details |
| PUT | /api/projects/[id] | Update project |
| DELETE | /api/projects/[id] | Delete project |
| GET | /api/projects/[id]/files | List project files |
| GET | /api/projects/[id]/sessions | List project sessions |
| GET | /api/projects/[id]/members | List project members |
| GET | /api/projects/[id]/invites | List project invites |
| GET | /api/projects/[id]/systemPrompts | List project system prompts |
| POST | /api/projects/[id]/systemPrompts/toggle | Toggle system prompt |
| POST | /api/projects/removeNonExistintFiles | Clean up orphan file references |

---

### Agents

Custom AI agents with configurable personas, system prompts, and tool access.

#### List Agents

\`\`\`
GET /api/agents
\`\`\`

**Response:**

\`\`\`json
{
  "agents": [
    {
      "id": "agent_abc123",
      "name": "Research Assistant",
      "description": "Specialized in academic research and citation",
      "systemPrompt": "You are a research assistant...",
      "model": "gpt-4o",
      "temperature": 0.3,
      "avatarUrl": "https://...",
      "tools": ["web-search", "web-fetch"],
      "isPublic": false,
      "createdAt": "2025-01-10T12:00:00Z"
    }
  ],
  "total": 5
}
\`\`\`

#### Agent Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/agents | List agents |
| POST | /api/agents | Create an agent |
| GET | /api/agents/[id] | Get agent details |
| PUT | /api/agents/[id] | Update agent |
| DELETE | /api/agents/[id] | Delete agent |
| POST | /api/agents/[id]/generate-avatar | AI-generate agent avatar |
| POST | /api/agents/[id]/generate-description | AI-generate agent description |
| POST | /api/agents/[id]/generate-system-prompt | AI-generate system prompt |
| POST | /api/agents/[id]/enhance-field | AI-enhance a specific field |
| POST | /api/agents/[id]/transfer-credits | Transfer credits to agent |
| POST | /api/agents/create-from-context | Create agent from conversation context |

---

### Organizations

Multi-tenant organization management with roles and integrations.

#### Organization Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/organizations | List user organizations |
| POST | /api/organizations | Create an organization |
| GET | /api/organizations/[id] | Get organization details |
| PUT | /api/organizations/[id] | Update organization |
| DELETE | /api/organizations/[id] | Delete organization |
| GET | /api/organizations/[id]/members | List members |
| POST | /api/organizations/[id]/members | Add member |
| PUT | /api/organizations/[id]/members/[memberId] | Update member role |
| DELETE | /api/organizations/[id]/members/[memberId] | Remove member |
| GET | /api/organizations/[id]/invites | List pending invites |
| POST | /api/organizations/[id]/invites | Send invite |
| GET | /api/organizations/stats | Organization statistics |
| GET | /api/organizations/users | List org users |
| POST | /api/organizations/create-dev | Create development org |
| POST | /api/organizations/subscriptions/subscribe | Subscribe org |
| POST | /api/organizations/subscriptions/update-seats | Update seat count |

#### GitHub Integration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/organizations/[id]/webhooks/github | List GitHub webhooks |
| POST | /api/organizations/[id]/webhooks/github | Create webhook |
| PUT | /api/organizations/[id]/webhooks/github/[hookId] | Update webhook |
| DELETE | /api/organizations/[id]/webhooks/github/[hookId] | Delete webhook |
| POST | /api/organizations/[id]/webhooks/github/rotate-secret | Rotate webhook secret |
| POST | /api/organizations/[id]/webhooks/github/test | Test webhook delivery |

#### Slack Integration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/slack/oauth/workspaces | List connected workspaces |
| GET | /api/slack/oauth/authorize | Start OAuth flow |
| GET | /api/slack/workspace/[workspaceId] | Get workspace details |
| POST | /api/slack/oauth/user-link/initiate | Link user to Slack |
| GET | /api/slack/export/channel-info | Channel export info |
| POST | /api/slack/export/channel | Export channel messages |
| POST | /api/slack/export/async | Async channel export |
| GET | /api/slack/export/status/[jobId] | Export job status |

---

### Users & Auth

#### Authentication Flows

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/otc/send | Request a one-time sign-in code (passwordless) |
| POST | /api/otc/verify | Verify code to log in or register |
| POST | /api/auth/refreshToken | Refresh access token |
| GET | /api/auth/strategy | Get available auth strategies |

#### OAuth Strategies

| Strategy | Initiate | Callback |
|----------|----------|----------|
| Google | GET /api/auth/google | GET /api/auth/google/callback |
| GitHub | GET /api/auth/github/authorize | GET /api/auth/github/callback (SSO), GET /api/auth/github/mcp-callback (MCP account linking) |
| Okta | GET /api/auth/okta | GET /api/auth/okta/callback |
| SAML | GET /api/auth/saml | POST /api/auth/saml/callback |

#### MFA (Multi-Factor Authentication)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/auth/mfa/setup | Begin MFA setup (returns QR code) |
| POST | /api/auth/mfa/verify-setup | Verify TOTP and activate MFA |
| POST | /api/auth/mfa/verify | Verify TOTP during login |
| POST | /api/auth/mfa/disable | Disable MFA |
| GET | /api/auth/mfa/status | Check MFA status |
| POST | /api/auth/mfa/regenerate-backup-codes | Generate new backup codes |
| POST | /api/auth/mfa/cancel-setup | Cancel in-progress setup |
| POST | /api/auth/mfa/force-reset | Admin force-reset user MFA |

#### User Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/users | List users (admin) |
| GET | /api/users/[id] | Get user profile |
| PUT | /api/users/[id]/update | Update user profile |
| DELETE | /api/users/[id]/delete | Delete user account |
| POST | /api/users/[id]/upload-photo | Upload profile photo |
| GET | /api/users/[id]/organizations | List user organizations |
| GET | /api/users/[id]/projects | List user projects |
| GET | /api/users/[id]/agents | List user agents |
| GET | /api/users/[id]/activities | User activity log |
| GET | /api/users/[id]/friends | List friends |
| GET | /api/users/[id]/friend-requests | Pending friend requests |
| GET | /api/users/[id]/collections | User collections |
| GET | /api/users/[id]/email-settings | Email preferences |
| PUT | /api/users/[id]/email-settings | Update email preferences |
| GET | /api/users/[id]/slack-settings | Slack notification preferences |
| PUT | /api/users/[id]/slack-settings | Update Slack preferences |
| GET | /api/users/[id]/ingested-emails | List ingested emails |
| GET | /api/users/[id]/userInvites | User invites |
| POST | /api/users/[id]/loginAs | Admin login-as user |
| POST | /api/users/[id]/recalculate-storage | Recalculate storage usage |
| GET | /api/users/by-email/[email] | Lookup user by email |
| GET | /api/users/activities/recent | Recent global activities |
| GET | /api/users/report | User report (admin) |
| GET | /api/users/tags | User tags |
| GET | /api/users/counterLogs | User counter logs |

---

### AI Services

Direct access to AI capabilities outside the chat flow.

#### LLM Completion

\`\`\`
POST /api/ai/llm
\`\`\`

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| prompt | string | Yes | The prompt text |
| model | string | No | Model identifier |
| temperature | number | No | Sampling temperature |
| maxTokens | number | No | Max output tokens |
| systemPrompt | string | No | System prompt override |

#### AI Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/ai/llm | Raw LLM completion |
| POST | /api/ai/transcribe | Audio/video to text (Whisper) |
| POST | /api/ai/text-to-speech | Text to speech synthesis |
| POST | /api/ai/generate-image | Image generation (DALL-E) |
| POST | /api/ai/edit-image | Image editing |
| POST | /api/ai/generate-video | Video generation (Sora) |
| POST | /api/ai/barkeep-chat | Tavern AI barkeep conversation |
| POST | /api/ai/tavern-conversation | Tavern NPC conversation |
| POST | /api/ai/v1/completions | OpenAI-compatible completions endpoint |
| GET | /api/ai/v1/tools | List available tools |
| POST | /api/ai/optimize-input | Optimize/rewrite user input |
| POST | /api/ai/refineText | Refine and improve text |
| POST | /api/ai/rapid-reply | Quick contextual reply generation |
| POST | /api/ai/test-realtime-voice | Test realtime voice session |
| POST | /api/ai/voice-sessions | Create voice session |

#### ElevenLabs Voice

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/elabs/text-to-speech | ElevenLabs TTS |
| GET | /api/elabs/ready | Check ElevenLabs availability |
| GET | /api/elabs/voice | List available voices |
| GET | /api/elabs/voice/[id] | Get voice details |
| POST | /api/elabs/voice/[id]/set-active | Set active voice |

---

### Artifacts

Versioned content artifacts generated during conversations (code, documents, diagrams).

#### Artifact Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/artifacts | List artifacts |
| POST | /api/artifacts | Create artifact |
| GET | /api/artifacts/[id] | Get artifact |
| PUT | /api/artifacts/[id] | Update artifact |
| DELETE | /api/artifacts/[id] | Delete artifact |
| GET | /api/artifacts/[id]/versions | List artifact versions |
| GET | /api/artifacts/[id]/versions/[version] | Get specific version |
| GET | /api/artifacts/search | Search artifacts |
| GET | /api/artifacts/types | List artifact types |
| GET | /api/artifacts/questmaster | QuestMaster artifacts |

---

### Quest Plans (QuestMaster)

Structured multi-step plans created by the QuestMaster agent.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/quest-plans | List quest plans |
| POST | /api/quest-plans | Create quest plan |
| GET | /api/quest-plans/[id] | Get quest plan |
| PUT | /api/quest-plans/[id] | Update quest plan |
| DELETE | /api/quest-plans/[id] | Delete quest plan |
| POST | /api/quest-plans/[id]/clone | Clone a plan |
| POST | /api/quest-plans/[id]/continue | Continue plan execution |
| GET | /api/quest-plans/[id]/export | Export plan |
| GET | /api/quest-plans/[id]/progress | Get plan progress |
| GET | /api/quest-master-plans/[id] | Get master plan |

---

### Sharing & Invites

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/[type]/[id]/updateSharing | Update sharing settings |
| POST | /api/[type]/[id]/revokeSharing | Revoke sharing |
| GET | /api/[type]/[id]/invites | List invites for resource |
| GET | /api/invites | List all invites |
| GET | /api/invites/[id] | Get invite details |
| POST | /api/invites/[id]/accept | Accept invite |
| POST | /api/invites/[id]/refuse | Refuse invite |

---

### Friends

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/friends | List friends |
| POST | /api/friends | Send friend request |
| GET | /api/friends/[id] | Get friend details |
| DELETE | /api/friends/[id] | Remove friend |
| POST | /api/friends/[id]/respond | Accept/decline request |
| GET | /api/friends/by-user/[id] | Get friendship by user |

---

### Feedback

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/feedback | List feedback |
| POST | /api/feedback | Submit feedback |
| GET | /api/feedback/[id]/read | Mark as read |
| PUT | /api/feedback/[id]/update | Update feedback |
| DELETE | /api/feedback/[id]/delete | Delete feedback |

---

### Help System

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/help | Get help articles |
| POST | /api/help/chat | Chat with help assistant |
| POST | /api/help/chat-feedback | Rate help response |
| POST | /api/help/feedback | Submit help feedback |
| GET | /api/help/my-feedback | Get your feedback |
| POST | /api/help/event | Log help event |

---

### Subscriptions & Billing

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/subscriptions | List subscriptions |
| GET | /api/subscriptions/own | Get own subscription |
| POST | /api/subscriptions/subscribe | Subscribe to a plan |
| POST | /api/subscriptions/change | Change plan |
| POST | /api/subscriptions/cancel | Cancel subscription |
| GET | /api/subscriptions/stats | Subscription statistics |
| GET | /api/subscriptions/[ownerType]/[ownerId] | Get subscription by owner |
| GET | /api/credits/transactions | Credit transaction history |
| POST | /api/stripe/start-payment | Start Stripe payment |
| GET | /api/stripe/portal | Open Stripe customer portal |
| GET | /api/stripe/subscription-plans | Available plans |

---

### Inbox / Notifications

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/inbox | List inbox messages |
| POST | /api/inbox/create | Create notification |
| POST | /api/inbox/admin-send | Admin broadcast notification |
| POST | /api/inbox/read | Mark messages as read |
| DELETE | /api/inbox/[id]/delete | Delete message |

---

### Settings & Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/settings/serverStatus | Health check / server status |
| GET | /api/settings/serverConfig | Server configuration |
| GET | /api/settings | Get app settings |
| PUT | /api/settings/update | Update settings |
| GET | /api/settings/fetch | Fetch specific setting |
| GET | /api/settings/logo | Get organization logo |

---

### Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/tools/web-search | Web search |
| POST | /api/tools/web-fetch | Fetch web page content |
| POST | /api/tools/weather | Get weather data |

---

### Research Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/research/agents | List research agents |
| POST | /api/research/agents | Create research agent |
| GET | /api/research/agents/[id] | Get research agent |
| PUT | /api/research/agents/[id] | Update research agent |
| DELETE | /api/research/agents/[id] | Delete research agent |
| GET | /api/research/agents/[id]/files | Research agent files |
| GET | /api/research/agents/[id]/tasks | List tasks |
| POST | /api/research/agents/[id]/tasks | Create task |
| GET | /api/research/agents/[id]/tasks/[taskId] | Get task |
| POST | /api/research/agents/[id]/tasks/[taskId]/retry | Retry task |
| GET | /api/research/data/files | Research data files |

---

### Keep (CLI Agent)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/keep/command | Send command to Keep CLI agent |

---

### Tavern

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/tavern/quests | Get tavern quests |
| POST | /api/tavern/trigger-heartbeat | Trigger heartbeat |
| POST | /api/tavern/zone-chat | Zone chat message |

---

### App Files (Static Assets)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/app-files | List app files |
| POST | /api/app-files/generate-presigned-url | Upload URL |
| GET | /api/app-files/get-file-url | Download URL |
| PUT | /api/app-files/update-tags | Update tags |
| DELETE | /api/app-files/delete | Delete app file |

---

## Admin Endpoints

Admin endpoints require the \`admin:*\` scope or superuser role.

### System Health & Monitoring

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/system-health | System health overview |
| GET | /api/admin/system-health/test-database | Test DB connection |
| GET | /api/admin/system-health/test-email | Test email delivery |
| GET | /api/admin/system-health/test-oauth | Test OAuth providers |
| GET | /api/admin/system-health/integration-health | Integration health |
| GET | /api/admin/integration-health-dashboard | Full health dashboard |

### Analytics & Metrics

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/analytics | Platform analytics |
| GET | /api/admin/model-metrics | LLM model usage metrics |
| GET | /api/admin/model-logs | LLM request logs |
| GET | /api/admin/event-metrics | Event metrics |
| GET | /api/admin/help-analytics | Help system analytics |

### DLQ (Dead Letter Queue) Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/dlq/queues | List DLQ queues |
| GET | /api/admin/dlq/messages | Get DLQ messages |
| POST | /api/admin/dlq/replay | Replay DLQ messages |
| GET | /api/admin/dlq/history | Replay history |

### Email Campaigns

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/email/jobs | List email jobs |
| POST | /api/admin/email/jobs | Create email job |
| GET | /api/admin/email/jobs/[id] | Get job details |
| PUT | /api/admin/email/jobs/[id] | Update job |
| DELETE | /api/admin/email/jobs/[id] | Delete job |
| POST | /api/admin/email/jobs/[id]/send | Send email job |
| POST | /api/admin/email/jobs/[id]/start | Start email job |
| POST | /api/admin/email/jobs/[id]/schedule | Schedule job |
| POST | /api/admin/email/jobs/[id]/cancel | Cancel job |
| POST | /api/admin/email/jobs/[id]/clone | Clone job |
| GET | /api/admin/email/jobs/[id]/analytics | Job analytics |
| GET | /api/admin/email/jobs/[id]/recipients | Job recipients |
| GET | /api/admin/email/jobs/[id]/summary | Job summary |
| GET | /api/admin/email/jobs/[id]/check-status | Check job status |
| POST | /api/admin/email/jobs/[id]/preview-for-user | Preview for user |
| POST | /api/admin/email/jobs/preview-recipients | Preview recipients |
| GET | /api/admin/email/templates | List templates |
| POST | /api/admin/email/templates | Create template |
| GET | /api/admin/email/templates/[id] | Get template |
| PUT | /api/admin/email/templates/[id] | Update template |
| DELETE | /api/admin/email/templates/[id] | Delete template |
| POST | /api/admin/email/templates/[id]/clone | Clone template |
| POST | /api/admin/email/templates/[id]/test | Send test email |
| GET | /api/admin/email/whats-new-content | What&apos;s New email content |
| GET | /api/admin/email/attempts/[id] | Get delivery attempt |

### Security Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/security-dashboard/overview | Security overview |
| GET | /api/admin/security-dashboard/code | Code scan results |
| POST | /api/admin/security-dashboard/code-semgrep-ingest | Ingest Semgrep results |
| GET | /api/admin/security-dashboard/packages | Package audit |
| POST | /api/admin/security-dashboard/packages-ingest | Ingest package audit |
| GET | /api/admin/security-dashboard/secrets | Secret scan results |
| POST | /api/admin/security-dashboard/secrets-ingest | Ingest secret scan |
| GET | /api/admin/security-dashboard/web | Web scan results |
| POST | /api/admin/security-dashboard/web-owasp-ingest | Ingest OWASP results |
| GET | /api/admin/security-dashboard/cloud | Cloud security |
| POST | /api/admin/security-dashboard/ai-assessment | AI security assessment |
| GET | /api/admin/security-scan-schedules | Scan schedules |
| PUT | /api/admin/security-scan-schedule/[scanType] | Update scan schedule |

### User Administration

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/admin/create-user | Create user |
| POST | /api/admin/bulk-create-users | Bulk create users |
| POST | /api/admin/users/[userId]/verify-email | Verify email |
| POST | /api/admin/users/[userId]/unverify-email | Unverify email |
| POST | /api/admin/users/[userId]/resend-verification | Resend verification |
| POST | /api/admin/users/[userId]/resend-email-change | Resend email change |
| POST | /api/admin/users/[userId]/generate-api-key | Generate API key |
| POST | /api/admin/users/[userId]/grant-subscription | Grant subscription |
| GET | /api/admin/users/[userId]/subscriptions | User subscriptions |
| PUT | /api/admin/users/[userId]/subscriptions/[subId]/credits | Adjust credits |
| DELETE | /api/admin/users/[userId]/subscriptions/[subId]/remove | Remove subscription |
| GET | /api/admin/users/email-verification | Email verification status |
| POST | /api/admin/emergency-login | Emergency admin login |
| GET | /api/admin/team-members | List team members |
| POST | /api/admin/recalculate-message-counts | Recalculate counts |

### System Configuration

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/system-secrets | List system secrets |
| POST | /api/admin/system-secrets | Create secret |
| PUT | /api/admin/system-secrets/[id] | Update secret |
| DELETE | /api/admin/system-secrets/[id] | Delete secret |
| GET | /api/admin/system-secrets/tier1-status | Tier 1 secrets status |
| GET | /api/admin/operations-model | Operations model config |
| PUT | /api/admin/operations-model | Update operations model |
| GET | /api/admin/llm-models/configurations | LLM model configurations |
| GET | /api/admin/rate-limits | View rate limits |
| PUT | /api/admin/rate-limits | Update rate limits |
| GET | /api/admin/rate-limits/ingest | Ingest rate limit data |

### System Prompts

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/system-prompts | List system prompts |
| POST | /api/admin/system-prompts | Create system prompt |
| GET | /api/admin/system-prompts/[promptId] | Get prompt |
| PUT | /api/admin/system-prompts/[promptId] | Update prompt |
| DELETE | /api/admin/system-prompts/[promptId] | Delete prompt |
| POST | /api/admin/system-prompts/[promptId]/create-version | Create version |
| POST | /api/admin/system-prompts/[promptId]/save-version | Save version |
| POST | /api/admin/system-prompts/[promptId]/switch-version | Switch active version |
| POST | /api/admin/system-prompts/[promptId]/reset | Reset to default |
| GET | /api/admin/system-prompts/[promptId]/history | Version history |
| POST | /api/admin/system-prompts/[promptId]/test | Test prompt |

### Tool Definitions

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/tool-definitions | List tool definitions |
| POST | /api/admin/tool-definitions | Create tool definition |
| GET | /api/admin/tool-definitions/[toolId] | Get tool definition |
| PUT | /api/admin/tool-definitions/[toolId] | Update tool definition |
| DELETE | /api/admin/tool-definitions/[toolId] | Delete tool definition |
| POST | /api/admin/tools/execute | Execute a tool |

### Identity Providers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/identity-providers | List providers |
| POST | /api/admin/identity-providers | Create provider |
| GET | /api/admin/identity-providers/[id] | Get provider |
| PUT | /api/admin/identity-providers/[id] | Update provider |
| DELETE | /api/admin/identity-providers/[id] | Delete provider |

### Context Telemetry

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/context-telemetry | List telemetry alerts |
| GET | /api/admin/context-telemetry/[id] | Get alert details |
| POST | /api/admin/context-telemetry/[id]/analyze | AI-analyze alert |
| POST | /api/admin/context-telemetry/[id]/create-issue | Create GitHub issue |
| GET | /api/admin/context-telemetry/integration-status | Integration status |
| GET | /api/admin/context-telemetry/metrics | Telemetry metrics |

### LiveOps Triage

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/liveops-triage-configs | List triage configs |
| POST | /api/admin/liveops-triage-configs | Create config |
| GET | /api/admin/liveops-triage-configs/[id] | Get config |
| PUT | /api/admin/liveops-triage-configs/[id] | Update config |
| DELETE | /api/admin/liveops-triage-configs/[id] | Delete config |
| GET | /api/admin/liveops-triage-configs/[id]/health | Config health |
| POST | /api/admin/liveops-triage-configs/[id]/trigger | Trigger triage |
| GET | /api/admin/liveops-triage-configs/runs | Triage run history |
| POST | /api/admin/liveops-triage/submit | Submit triage job |
| GET | /api/admin/liveops-triage/status/[jobId] | Job status |
| GET | /api/admin/liveops-triage-env | Triage environment info |

### Rapid Reply

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/rapid-reply/prompts | List prompts |
| POST | /api/admin/rapid-reply/prompts | Create prompt |
| GET | /api/admin/rapid-reply/prompts/[id] | Get prompt |
| PUT | /api/admin/rapid-reply/prompts/[id] | Update prompt |
| DELETE | /api/admin/rapid-reply/prompts/[id] | Delete prompt |
| POST | /api/admin/rapid-reply/prompts/[id]/activate | Activate prompt |
| GET | /api/admin/rapid-reply/mappings | List mappings |
| POST | /api/admin/rapid-reply/mappings | Create mapping |
| PUT | /api/admin/rapid-reply/mappings/[id] | Update mapping |
| DELETE | /api/admin/rapid-reply/mappings/[id] | Delete mapping |
| POST | /api/admin/rapid-reply/mappings/bulk | Bulk update mappings |
| GET | /api/admin/rapid-reply/metrics | Rapid reply metrics |
| POST | /api/admin/rapid-reply/test | Test rapid reply |

### Agent Ops

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/agent-ops-settings | Get agent ops settings |
| PUT | /api/admin/agent-ops-settings | Update settings |
| POST | /api/admin/agent-ops-settings/seed | Seed default settings |
| POST | /api/admin/agent-ops-settings/repair | Repair settings |
| GET | /api/admin/agent-ops-settings/versions | Version history |
| POST | /api/admin/agent-ops-settings/versions/[version]/activate | Activate version |

### What&apos;s New

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/whats-new-config | Get config |
| PUT | /api/admin/whats-new-config | Update config |
| GET | /api/admin/whats-new-config/history | Config history |
| GET | /api/admin/whats-new-config/preview | Preview content |
| POST | /api/admin/whats-new-config/restore | Restore config |
| GET | /api/admin/whats-new/available | Available content |
| POST | /api/admin/whats-new/sync | Sync from source |
| POST | /api/admin/whats-new/import | Import content |
| GET | /api/admin/whats-new/config | Alternate config endpoint |
| POST | /api/admin/whats-new-backfill | Backfill content |
| POST | /api/admin/generate-highlights | Generate highlights |
| GET | /api/admin/whats-new-generation-status | Generation status |
| GET | /api/admin/whats-new-highlights-config | Highlights config |
| PUT | /api/admin/whats-new-highlights-config | Update highlights config |
| GET | /api/admin/whats-new-highlights-preview | Preview highlights |

### GitHub Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/github/connection | Connection status |
| POST | /api/admin/github/test | Test connection |
| GET | /api/admin/github/repositories | List repositories |
| GET | /api/admin/github/rate-limit | GitHub rate limit |
| POST | /api/admin/github/rotate-key | Rotate GitHub key |

### Slack Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/slack-workspaces | List workspaces |
| POST | /api/admin/slack-app/create | Create Slack app |
| POST | /api/admin/slack-app/reconnect | Reconnect Slack |
| GET | /api/admin/slack-app/manifest-status | Manifest status |
| POST | /api/admin/slack-app/update-manifest | Update manifest |
| GET | /api/admin/slack-audit-logs | Slack audit logs |
| GET | /api/admin/integration-audit-logs | Integration audit logs |

### Webhook Logs

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/webhook-logs | List webhook logs |
| GET | /api/admin/webhook-logs/[deliveryId] | Get log details |
| GET | /api/admin/webhook-logs/stats | Webhook statistics |

### Miscellaneous Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/admin/modal-tool | Admin modal tool |
| POST | /api/admin/upload-logo | Upload organization logo |

---

## Response Shapes

### Standard Paginated Response

\`\`\`json
{
  "items": [...],
  "total": 142,
  "page": 1,
  "limit": 20,
  "hasMore": true
}
\`\`\`

### Quest Response

\`\`\`json
{
  "id": "quest_abc123",
  "sessionId": "sess_xyz789",
  "status": "completed",
  "reply": {
    "content": "The AI response text...",
    "model": "gpt-4o",
    "tokensUsed": {
      "input": 150,
      "output": 320
    },
    "sources": [
      {
        "fileId": "file_123",
        "fileName": "report.pdf",
        "chunkIndex": 3,
        "score": 0.92,
        "text": "Relevant excerpt..."
      }
    ],
    "artifacts": [
      {
        "id": "art_456",
        "type": "code",
        "title": "analysis.py",
        "content": "..."
      }
    ]
  },
  "createdAt": "2025-01-15T10:30:00Z",
  "completedAt": "2025-01-15T10:30:05Z"
}
\`\`\`

### File Response

\`\`\`json
{
  "id": "file_abc123",
  "name": "quarterly-report.pdf",
  "originalName": "Q4 Report Final.pdf",
  "size": 1048576,
  "mimeType": "application/pdf",
  "tags": ["reports", "Q4"],
  "chunked": true,
  "chunkCount": 24,
  "embeddingModel": "text-embedding-3-small",
  "projectId": "proj_xyz",
  "userId": "user_123",
  "s3Key": "files/user_123/file_abc123.pdf",
  "createdAt": "2025-01-10T08:00:00Z",
  "updatedAt": "2025-01-10T08:05:00Z"
}
\`\`\`

### Agent Response

\`\`\`json
{
  "id": "agent_abc123",
  "name": "Research Assistant",
  "description": "Specialized in academic research and citation management",
  "systemPrompt": "You are a research assistant specialized in...",
  "model": "gpt-4o",
  "temperature": 0.3,
  "avatarUrl": "https://cdn.your-deployment.example.com/avatars/agent_abc123.png",
  "tools": ["web-search", "web-fetch"],
  "isPublic": false,
  "userId": "user_123",
  "organizationId": "org_456",
  "createdAt": "2025-01-10T12:00:00Z",
  "updatedAt": "2025-01-12T09:30:00Z"
}
\`\`\`

### Session Response

\`\`\`json
{
  "id": "sess_abc123",
  "title": "Quarterly Analysis Discussion",
  "messageCount": 12,
  "model": "gpt-4o",
  "agentId": "agent_xyz",
  "projectId": "proj_456",
  "tags": ["analysis", "Q4"],
  "isFavorite": false,
  "isShared": false,
  "userId": "user_123",
  "messages": [
    {
      "id": "msg_001",
      "role": "user",
      "content": "Analyze the quarterly report",
      "createdAt": "2025-01-15T10:00:00Z"
    },
    {
      "id": "msg_002",
      "role": "assistant",
      "content": "Based on the quarterly report...",
      "model": "gpt-4o",
      "tokensUsed": { "input": 200, "output": 450 },
      "sources": [],
      "createdAt": "2025-01-15T10:00:05Z"
    }
  ],
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-15T11:30:00Z"
}
\`\`\`

---

## Error Handling

### Standard Error Response

\`\`\`json
{
  "error": "Descriptive error message",
  "code": "ERROR_CODE",
  "details": {}
}
\`\`\`

### Common Status Codes

| Status | Meaning | Description |
|--------|---------|-------------|
| 200 | OK | Request succeeded |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid request body or parameters |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Insufficient permissions or scope |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Resource already exists or version conflict |
| 422 | Unprocessable Entity | Validation error (Zod schema failure) |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Unexpected server error |
| 503 | Service Unavailable | Service temporarily unavailable |

### Validation Errors (422)

\`\`\`json
{
  "error": "Validation failed",
  "code": "VALIDATION_ERROR",
  "details": {
    "issues": [
      {
        "path": ["body", "message"],
        "message": "Required",
        "code": "invalid_type"
      }
    ]
  }
}
\`\`\`

### Authentication Errors (401)

\`\`\`json
{
  "error": "Token expired",
  "code": "TOKEN_EXPIRED"
}
\`\`\`

Use the refresh token flow to obtain a new access token:

\`\`\`
POST /api/auth/refreshToken
Content-Type: application/json

{
  "refreshToken": "<refresh_token>"
}
\`\`\`

---

## WebSocket Events

Real-time updates are delivered via WebSocket. Connect to the WebSocket endpoint with your access token.

### Key Events

| Event | Direction | Description |
|-------|-----------|-------------|
| \`quest:started\` | Server → Client | Quest processing began |
| \`quest:chunk\` | Server → Client | Streaming response chunk |
| \`quest:completed\` | Server → Client | Quest finished |
| \`quest:error\` | Server → Client | Quest processing failed |
| \`session:updated\` | Server → Client | Session metadata changed |
| \`notification:new\` | Server → Client | New inbox notification |
| \`file:chunked\` | Server → Client | File chunking completed |
| \`proactive:message\` | Server → Client | Agent proactive message |

---

## Tips for Development

1. **Always use the authenticated client.** In the B4M frontend, import \`api\` from \`@client/app/contexts/ApiContext\` rather than using \`fetch()\`. The \`api\` instance handles token refresh, request IDs, and error interceptors automatically.

2. **Poll quests, don&apos;t block on chat.** The \`POST /api/chat\` endpoint returns immediately with a \`questId\`. Poll \`GET /api/quests/[id]\` or listen on WebSocket for \`quest:completed\` to get the response.

3. **Use streaming for better UX.** Pass \`stream: true\` in chat requests and listen for \`quest:chunk\` WebSocket events to display tokens as they arrive.

4. **Leverage RAG with file context.** Attach \`fileIds\` or \`projectId\` to chat requests to ground AI responses in your uploaded documents. Files must be chunked first via \`POST /api/files/chunk\`.

5. **Handle 429s gracefully.** Implement exponential backoff when you receive rate limit responses. Check \`X-RateLimit-Reset\` header for the retry timestamp.

6. **Use Zod schemas for validation.** All request bodies are validated with Zod schemas on the server. Match the expected schema to avoid 422 errors. Shared schemas are in \`@bike4mind/common\`.

7. **Prefer pagination over fetching all.** All list endpoints support \`page\` and \`limit\` parameters. Default page size is 20. Never fetch unbounded lists in production.

8. **Token lifecycle matters.** Access tokens expire after 7 days. Use the refresh token flow (\`POST /api/auth/refreshToken\`) to get new tokens without requiring re-authentication.

9. **Test with the server status endpoint.** Use \`GET /api/settings/serverStatus\` as a lightweight health check. It returns server version, uptime, and configuration without requiring authentication.

10. **Every response carries a request ID.** The API attaches an \`X-Request-ID\` header to every response — success and error — so you can correlate a failure with our server logs. Supply your own \`X-Request-ID\` and the server echoes it back; omit it and the server generates one. Caller-supplied values are sanitized to the characters \`A-Za-z0-9._-\` and capped at 128 characters. Include this ID in support tickets.

    \`\`\`bash
    # Send a correlation ID and read it back from the response headers
    curl -i -X POST https://your-deployment.example.com/api/chat \\
      -H "Authorization: Bearer $TOKEN" \\
      -H "Content-Type: application/json" \\
      -H "X-Request-ID: my-trace-001" \\
      -d '{"message":"hello"}'
    # Response header → X-Request-ID: my-trace-001
    # Error responses also include it in the body → { "request_id": "my-trace-001", ... }
    \`\`\`

    For streaming completions (\`/api/ai/v1/completions\`), the request ID arrives as the first SSE \`meta\` event:

    \`\`\`text
    data: {"type":"meta","requestId":"my-trace-001"}
    \`\`\`

    This is request **correlation**, not idempotency — reusing an ID does not deduplicate retries.
`;
