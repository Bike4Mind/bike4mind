// brand externalized
import { getBrandName } from '@client/config/general';
import {
  API_KEY_RATE_LIMIT_DEFAULTS,
  API_KEY_RATE_LIMIT_HEADER_NAMES,
  API_KEY_RATE_LIMIT_HEADERS,
  MAX_REQUEST_ID_LENGTH,
  MIN_PASSAGE_TOKEN_TARGET,
  OVERSIZED_PASSAGE_TOKEN_THRESHOLD,
} from '@bike4mind/common';
import type { ApiKeyScopeOption } from '@client/app/constants/apiKeyScopes';

// Generated from the same catalog the New-Key modals offer, so the table can't drift from
// what a user can actually select. A literal `|` would split a GFM table cell.
export const renderScopeTableRows = (scopes: ApiKeyScopeOption[]): string =>
  scopes.map(scope => `| \`${scope.value}\` | ${scope.description.replaceAll('|', '\\|')} |`).join('\n');

/**
 * `baseUrl` is the deployment's origin, so the examples are runnable as copied. `scopes` is the
 * viewer's generic scope list (useGenericApiKeyScopes), so premium scopes are hidden from viewers without Opti access.
 */
export const getApiReferenceContent = (baseUrl: string, scopes: ApiKeyScopeOption[]): string => `
# ${getBrandName()} API Reference

API reference for ${getBrandName()}, a cognitive workbench platform. All endpoints are served from \`${baseUrl}\`.

> **Scope of this page.** Internal and admin endpoints are intentionally not documented here.
> Public endpoints are documented in the generated, contract-driven docs at
> [/api/v1/docs](/api/v1/docs).
> What remains below is prose with no generated counterpart plus a few endpoint sections still
> waiting to be migrated.

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
| Access Token | 30 minutes | Short-lived token for API requests |
| Refresh Token | 30 days | Used to obtain new access tokens |

**Obtaining tokens:** sign in through the product (passwordless email code or an OAuth provider).
\`POST /api/auth/refreshToken\` exchanges a refresh token for a new access token.

Browser clients never receive the refresh token in a response body: it is set as an
\`HttpOnly; Secure; SameSite=Strict\` cookie scoped to \`/api\`, and \`POST /api/auth/refreshToken\`
reads and rotates it from there. Non-browser clients (CLI, OAuth authorization-code and device
flows) get the refresh token in the response body and send it back the same way.

### API Key Authentication

API keys use the \`b4m_live_\` prefix. Send one as a bearer token:

\`\`\`
Authorization: Bearer b4m_live_xxxxx
\`\`\`

The legacy \`X-API-Key: b4m_live_xxxxx\` and \`Authorization: ApiKey b4m_live_xxxxx\` forms are still accepted.

**Managing API keys:**

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/user-api-keys | List your active API keys (add \`?includeDisabled=true\` to also return revoked ones) |
| POST | /api/user-api-keys | Create a new API key (scopes are checked against the caller's own, see Scopes below) |
| POST | /api/api-keys/create | Create a new API key |
| POST | /api/user-api-keys/[id]/rotate | Rotate an existing key (an API-key caller may only rotate a key whose scopes it already holds - see Scopes below) |
| POST | /api/user-api-keys/[id]/revoke | Revoke a key |
| POST | /api/api-keys/[id]/set-active | Activate/deactivate a key |
| DELETE | /api/api-keys/[id]/delete | Delete a key |

### Scopes

API keys can be scoped to limit access. Available scopes:

| Scope | Description |
|-------|-------------|
${renderScopeTableRows(scopes)}
| \`admin:*\` | Full admin access (superuser only; provisioned out of band, not selectable when creating a key) |

An API-key caller can't escalate through key management: creating a key via
\`POST /api/user-api-keys\` or rotating one is refused unless the calling key already holds
every scope involved. Containment is checked literally: \`admin:*\` is not treated as a
superset of other scopes, so an \`admin:*\`-scoped key still can't mint or rotate a key
holding scopes it doesn't literally list.

### Rate Limits

| Limit | Default |
|-------|---------|
| Requests per minute | ${API_KEY_RATE_LIMIT_DEFAULTS.requestsPerMinute.toLocaleString('en-US')} |
| Requests per day | ${API_KEY_RATE_LIMIT_DEFAULTS.requestsPerDay.toLocaleString('en-US')} |

A key can be minted with its own ceilings. Responses from rate-limited routes called with an API
key carry the current state of both windows:

${API_KEY_RATE_LIMIT_HEADER_NAMES.map(header => `- \`${header}\`: ${API_KEY_RATE_LIMIT_HEADERS[header]}`).join('\n')}

A request refused at the route scope gate (\`403\`) or for a bad key (\`401\`) never reaches the
limiter and carries none of these headers. Exceeding a ceiling returns \`429 Too Many Requests\` with
a \`Retry-After\` header giving the seconds to wait before retrying; the streaming completions
endpoint (\`POST /api/ai/v1/completions\`) opens its event stream first, so an exceeded ceiling
arrives there as an in-stream \`error\` event rather than a \`429\`.

Some reads and job polls are exempt from the per-day ceiling and count only against the
per-minute one; the Rate limits section of the [generated API docs](/api/v1/docs) lists them.

---

## Public endpoints (generated docs)

These endpoints are defined by a contract, and their full request/response reference lives in
the [generated API docs](/api/v1/docs) (raw spec: \`/api/v1/openapi.json\`, which a generator can
use to build a typed client). They are deliberately not repeated here, so the two cannot disagree.

- Chat and quests: \`/api/chat\`, \`/api/v1/quests/{id}\`, \`/api/v1/agent-executions[/{id}]\`
- Sessions: \`/api/v1/sessions\`, \`/api/sessions/{id}\`
- Projects: \`/api/v1/projects\`, \`/api/v1/projects/{id}\`
- Files and data lakes: \`/api/v1/files\`, \`/api/v1/files/{id}\`, \`/api/v1/data-lakes\`, \`/api/v1/data-lakes/*\`
- Generation: \`/api/v1/image-generations\`, \`/api/v1/image-edits\`, \`/api/v1/video-*\`,
  \`/api/v1/voice/*\`, \`/api/ai/tts\`, \`/api/ai/music\`, \`/api/ai/sound-effects\`
- Completions, embeddings and tools: \`/api/ai/v1/*\`, \`/api/v1/embeddings\`
- Account and models: \`/api/v1/me\`, \`/api/v1/credits\`, \`/api/v1/models\`

Image, video and chat work is asynchronous; the Async jobs section of the
[generated API docs](/api/v1/docs) says what to poll for each kind of job and when it is terminal.

---

## Endpoints not yet migrated

The sections below are still hand-written. Each row was checked against its route file, but
treat the handler as authoritative.

### Quest files

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/quests/[id]/files | Files generated or referenced during quest processing |

**Required API-key scope:** \`notebooks:read\`, \`ai:chat\`, or \`ai:generate\` (any one grants access).

---

### Files (FabFiles)

Manage uploaded files, trigger chunking for RAG, and search file content.

#### List Files

\`\`\`
GET /api/files
\`\`\`

**Query Parameters:**

Nested keys use bracket syntax (parsed with \`qs\`), for example \`pagination[page]=2&order[by]=createdAt&order[direction]=desc\`.

| Param | Type | Description |
|-------|------|-------------|
| search | string | Search by filename |
| filters[tags] | string[] | Only files carrying these tags |
| filters[type] | string | One of \`text\`, \`pdf\`, \`url\`, \`image\`, \`excel\`, \`word\`, \`json\`, \`csv\`, \`markdown\`, \`code\`, \`audio\`, \`video\` |
| filters[shared] | boolean | Files shared with you |
| filters[curated] | boolean | Curated notebook files |
| filters[projectId] | string | Only files in this project |
| filters[ids] | string[] | Only these file ids |
| pagination[page] | number | Page number (default 1) |
| pagination[limit] | number | Items per page (default 20) |
| order[by] | string | \`createdAt\`, \`fileName\` or \`fileSize\` (default \`fileName\`) |
| order[direction] | string | \`asc\` or \`desc\` (default \`asc\`) |
| options[textSearch] | boolean | Use text search for \`search\` |
| options[excludeContent] | boolean | Omit file content from the results |

**Query-parameter gotchas.** \`pagination\` and \`order\` are all-or-nothing: send every key of a nested object or omit the object entirely, or the request is a 422 (the documented defaults apply only when you omit the object). Boolean params are coerced, so any non-empty value - including \`false\` - enables them; omit the key to disable. Array params take a repeated key (\`filters[tags]=a&filters[tags]=b\`); the \`[]\` suffix works too, but a list longer than 20 turns into an object (\`qs\` arrayLimit) that the schema rejects. A single bare value is rejected.

The response is \`{ data, hasMore, total }\`, where \`data\` is the page of files.

#### Trigger Chunking

\`\`\`
POST /api/files/chunk
\`\`\`

Initiates the chunking and embedding pipeline for a file.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| fabFileId | string | Yes | File ID to chunk |
| chunkSize | integer | Yes | Passage target in tokens. Must be an integer between ${MIN_PASSAGE_TOKEN_TARGET} and ${OVERSIZED_PASSAGE_TOKEN_THRESHOLD}, inclusive. |

#### File Endpoints Summary

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/files | List files with pagination and filters |
| GET | /api/files/[id] | Get file details |
| PUT | /api/files/[id] | Update file metadata |
| DELETE | /api/files/[id] | Delete a file |
| POST | /api/files/chunk | Trigger chunking pipeline |
| GET | /api/files/search | Full-text search across file content |
| DELETE | /api/files/bulk-delete | Delete multiple files |
| GET | /api/files/byIds | Get multiple files by ID |
| POST | /api/files/generate-presigned-url | Generate presigned upload URL (internal; use /api/v1/files) |
| GET | /api/files/getFabFileNameById | Get filename by ID |

---

### Sessions (Notebooks)

Session create, list, get, update and delete are covered by the generated docs (see above). The routes below are
still hand-written.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/sessions/[id]/clone | Clone a session |
| GET | /api/sessions/[id]/files | List session files |
| POST | /api/sessions/semantic-search | Semantic search across sessions |
| GET | /api/sessions/[id]/chat/[messageId] | Get a specific message |
| PUT | /api/sessions/[id]/chat/[messageId] | Update a message |
| DELETE | /api/sessions/[id]/chat/[messageId] | Delete a message |

#### Release Notes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/v1/whats-new | Published release notes, newest first (public, cursor-paginated, cached) |

---

### Projects

Project create, list, get, update and delete are covered by the generated docs (see above). The routes below are
still hand-written.

**Required API-key scope:** \`projects:read\` (or \`projects:write\`) for the GET routes, \`projects:write\` for the rest.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/projects/[id]/files | List project files |
| GET | /api/projects/[id]/sessions | List project sessions |
| DELETE | /api/projects/[id]/members | Remove a project member (send \`userId\` in the body), or leave the project when omitted |
| GET | /api/projects/[id]/invites | List project invites (requires share permission) |
| POST | /api/projects/[id]/systemPrompts | Add system prompt files to a project (\`fileIds\` in the body) |
| DELETE | /api/projects/[id]/systemPrompts | Remove system prompt files from a project (\`fileIds\`, or legacy single \`fileId\`, in the body) |
| POST | /api/projects/[id]/systemPrompts/toggle | Toggle system prompt |
| DELETE | /api/projects/removeNonExistintFiles | Clean up orphan file references |

---

### Agents

Custom AI agents with configurable personas, system prompts, and tool access.

\`GET /api/agents\` is paginated and accepts \`query\`, \`page\`, \`limit\`, \`orderBy\` (\`createdAt\` or
\`updatedAt\`) and \`orderDirection\`.

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

### AI Services

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/ai/transcribe | Audio/video to text (Whisper) |
| POST | /api/ai/refineText | Refine and improve text |

**Required API-key scope for \`refineText\`:** \`ai:generate\`.

---

### Artifacts

Versioned content artifacts generated during conversations (code, documents, diagrams).

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/artifacts | List artifacts |
| POST | /api/artifacts | Create artifact |
| GET | /api/artifacts/[id] | Get artifact |
| PUT | /api/artifacts/[id] | Update artifact |
| DELETE | /api/artifacts/[id] | Delete artifact |
| GET | /api/artifacts/[id]/versions | List artifact versions |
| POST | /api/artifacts/[id]/versions | Add an artifact version |
| GET | /api/artifacts/[id]/versions/[version] | Get specific version |
| GET | /api/artifacts/search | Search artifacts |
| GET | /api/artifacts/types | List artifact types |

---

### Tools

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/tools/web-search | Web search |
| POST | /api/tools/web-fetch | Fetch web page content |
| POST | /api/tools/weather | Get weather data |

---

## Error Handling

Public endpoints share one JSON error envelope and one status table (400 vs 422 and the rest),
both described in the Errors section of the [generated API docs](/api/v1/docs); each generated
operation lists the statuses it can return.
Older hand-written routes may not follow the envelope exactly.

When an access token expires the API answers 401. Exchange the refresh token at
\`POST /api/auth/refreshToken\`: non-browser clients pass it in the body, and a browser sends an
empty body and the HttpOnly cookie supplies it.

---

## WebSocket Events

Real-time updates are delivered via WebSocket. Connect to the WebSocket endpoint with your access token.

### Key Events

| Action | Direction | Description |
|--------|-----------|-------------|
| \`streamed_chat_completion\` | Server -> Client | Streamed chat reply: the quest's partial or final \`reply\`, its \`status\` and, on failure, \`type: "error"\` |
| \`generation_job_updated\` | Server -> Client | A generation job's \`state\`, \`progress\` and \`output\` changed |
| \`update_file_chunk_vector_status\` | Server -> Client | A file's chunking / vectorizing status changed (\`ongoing\`, \`complete\`, \`failed\`) |

---

## Tips for Development

1. **Poll quests, don&apos;t block on chat.** By default \`POST /api/chat\` returns immediately with a queued ACK whose \`id\` is the quest id. Poll \`GET /api/v1/quests/{id}\` until it is terminal to get the response, or pass \`wait: true\` to block and receive the completed turn inline.

2. **Use streaming for better UX.** Pass \`stream: true\` in chat requests and listen for \`streamed_chat_completion\` WebSocket actions to display the reply as it arrives.

3. **Leverage RAG with file context.** Attach \`fileIds\` to chat requests to ground AI responses in your uploaded documents. Files must be chunked first via \`POST /api/files/chunk\`.

4. **Handle 429s gracefully.** On a 429, wait the number of seconds in the \`Retry-After\` header before retrying. Each window's \`Reset\` header, listed under Rate Limits, gives its reset time in Unix epoch seconds.

5. **Use Zod schemas for validation.** All request bodies are validated with Zod schemas on the server. Match the expected schema to avoid 422 errors. Shared schemas are in \`@bike4mind/common\`.

6. **Token lifecycle matters.** Access tokens expire after 30 minutes. Use the refresh token flow (\`POST /api/auth/refreshToken\`) to get new tokens without requiring re-authentication.

7. **Every response carries a request ID.** The API attaches an \`X-Request-ID\` header to every response (success and error) so you can correlate a failure with our server logs. Supply your own \`X-Request-ID\` and the server echoes it back; omit it and the server generates one. Caller-supplied values are sanitized to the characters \`A-Za-z0-9._-\` and capped at ${MAX_REQUEST_ID_LENGTH} characters. Include this ID in support tickets.

    \`\`\`bash
    # Send a correlation ID and read it back from the response headers
    curl -i -X POST ${baseUrl}/api/chat \\
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
