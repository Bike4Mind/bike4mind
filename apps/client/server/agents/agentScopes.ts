import { ApiKeyScope } from '@bike4mind/common';
import { assertApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * API-key scopes for the SPA-internal `/api/agents` doors. Write does not imply read, matching the
 * files family (server/files/fileScopes.ts).
 *
 * Enforcement sites: every route under `pages/api/agents`, pinned by
 * server/__tests__/projectsAgentsApiKeyScopeCoverage.test.ts. Mixed-method doors declare the
 * read-or-write gate below and assert per method.
 *
 * The authoring assistants (`generate-*`, `enhance-field`) and `embed-keys` gate on `agents:write`:
 * they spend credits or expose widget credentials for an agent, which is management of that agent,
 * not a read of it.
 */
export const AGENTS_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.READ_AGENTS];

export const AGENTS_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.WRITE_AGENTS];

/** Route gate for a door that serves both a read and a write; each method then asserts its own. */
export const AGENTS_READ_OR_WRITE_SCOPES: ApiKeyScope[] = [...AGENTS_READ_SCOPES, ...AGENTS_WRITE_SCOPES];

export function assertAgentsReadScope(req: ScopedRequest): void {
  assertApiKeyScope(req, AGENTS_READ_SCOPES, 'This API key cannot read agents; agents:read is required');
}

export function assertAgentsWriteScope(req: ScopedRequest): void {
  assertApiKeyScope(req, AGENTS_WRITE_SCOPES, 'This API key is read-only for agents; agents:write is required');
}
