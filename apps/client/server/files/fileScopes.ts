import { ApiKeyScope } from '@bike4mind/common';
import { assertApiKeyScope, type ScopedRequest } from '@server/middlewares/apiKeyScopeGate';

/**
 * API-key scopes for the SPA-internal `/api/files` doors. They mirror the public doors'
 * contracts (b4m-core/common/src/api-contract/contracts/files.contract.ts): upload needs
 * `files:write`, read needs `files:read`, and write does not imply read.
 *
 * Enforcement sites: `files/generate-presigned-url.ts` (write), `files/presigned-url.ts`
 * (read), `files/[id]/index.ts` (route gate below, plus the per-method asserts). Keep this
 * list complete - a scope preflight is sized from the enforcement sites
 * (docs/architecture/api-key-scope-rollout.md).
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
