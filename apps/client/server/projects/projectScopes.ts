import { ApiKeyScope } from '@bike4mind/common';
import { assertApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * API-key scopes for the SPA-internal `/api/projects` doors. Write does not imply read, matching the
 * files family (server/files/fileScopes.ts).
 *
 * Enforcement sites: every route under `pages/api/projects`, pinned by
 * server/__tests__/projectsAgentsApiKeyScopeCoverage.test.ts. Mixed-method doors declare the
 * read-or-write gate below and assert per method, so a preflight for these scopes is sized over
 * `/api/projects` (docs/architecture/api-key-scope-rollout.md).
 */
export const PROJECTS_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.READ_PROJECTS];

export const PROJECTS_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.WRITE_PROJECTS];

/** Route gate for a door that serves both a read and a write; each method then asserts its own. */
export const PROJECTS_READ_OR_WRITE_SCOPES: ApiKeyScope[] = [...PROJECTS_READ_SCOPES, ...PROJECTS_WRITE_SCOPES];

export function assertProjectsReadScope(req: ScopedRequest): void {
  assertApiKeyScope(req, PROJECTS_READ_SCOPES, 'This API key cannot read projects; projects:read is required');
}

export function assertProjectsWriteScope(req: ScopedRequest): void {
  assertApiKeyScope(req, PROJECTS_WRITE_SCOPES, 'This API key is read-only for projects; projects:write is required');
}
