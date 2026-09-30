import { ApiKeyScope } from '@bike4mind/common';
import { assertApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * API-key scopes for the SPA-internal `/api/files` doors. They mirror the public doors'
 * contracts (b4m-core/common/src/api-contract/contracts/files.contract.ts): upload needs
 * `files:write`, read needs `files:read`, and write does not imply read.
 *
 * Enforcement sites: every route under `pages/api/files`, pinned by
 * server/__tests__/filesApiKeyScopeCoverage.test.ts. The mixed-method doors (`files/index.ts`,
 * `files/[id]/index.ts`, `files/tags/index.ts`) declare the read-or-write gate below and assert
 * per method. So a preflight for these scopes is sized over `/api/files` plus the public
 * `/api/v1/files` doors (docs/architecture/api-key-scope-rollout.md).
 *
 * `files/generate-smart-name.ts` spends LLM budget yet gates on `files:write`: it exists only
 * inside the paste-to-upload flow, and gating it on `ai:generate` would mean staging that scope
 * too, which re-opens every `ai:generate` door for the window.
 */
export const FILES_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.READ_FILES];

export const FILES_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.WRITE_FILES];

/** Route gate for a door that serves both a read and a write; each method then asserts its own. */
export const FILES_READ_OR_WRITE_SCOPES: ApiKeyScope[] = [...FILES_READ_SCOPES, ...FILES_WRITE_SCOPES];

export function assertFilesReadScope(req: ScopedRequest): void {
  assertApiKeyScope(req, FILES_READ_SCOPES, 'This API key cannot read files; files:read is required');
}

export function assertFilesWriteScope(req: ScopedRequest): void {
  assertApiKeyScope(req, FILES_WRITE_SCOPES, 'This API key is read-only for files; files:write is required');
}
