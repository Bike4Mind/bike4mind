import { ApiKeyScope } from '@bike4mind/common';
import {
  assertApiKeyScope,
  holdsApiKeyScope,
  type ScopedRequest,
} from '@bike4mind/server-utils/middlewares/apiKeyScopeGate';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';

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
 * `files:read` alone never reaches data-lake content: every read door with a lake fallback or lake
 * arm drops it for a key without datalake:read (loadAccessibleFabFile, byIds, presigned-url, and
 * the search/tags doors via buildRequestFileScope in server/utils/userFileScope.ts).
 *
 * `files/generate-smart-name.ts` spends LLM budget yet gates on `files:write`: it exists only
 * inside the paste-to-upload flow, and gating it on `ai:generate` would mean staging that scope
 * too, which re-opens every `ai:generate` door for the window.
 */
export const FILES_READ_SCOPES: ApiKeyScope[] = [ApiKeyScope.READ_FILES];

export const FILES_WRITE_SCOPES: ApiKeyScope[] = [ApiKeyScope.WRITE_FILES];

/** Route gate for a door that serves both a read and a write; each method then asserts its own. */
export const FILES_READ_OR_WRITE_SCOPES: ApiKeyScope[] = [...FILES_READ_SCOPES, ...FILES_WRITE_SCOPES];

/**
 * Route gate for the two doors an `ai:generate` key may reach in a narrow form (the image-edit
 * upload flow): generate-presigned-url admits it beside files:write, and `/api/files/{id}` beside
 * both files scopes. Each handler narrows an ai:generate key without the files scope in-handler.
 */
export const FILES_WRITE_OR_GENERATE_SCOPES: ApiKeyScope[] = [...FILES_WRITE_SCOPES, ApiKeyScope.AI_GENERATE];

/**
 * createFabFile's gate: a release-notes:write key may upload only an admin's What's New media there,
 * which the handler narrows to; see isReleaseNotesOnlyUpload.
 */
export const FILES_WRITE_OR_RELEASE_NOTES_SCOPES: ApiKeyScope[] = [
  ...FILES_WRITE_SCOPES,
  ApiKeyScope.RELEASE_NOTES_WRITE,
];

/** True for an API key that reached a files door through release-notes:write rather than files:write. */
export function isReleaseNotesOnlyUpload(req: ScopedRequest): boolean {
  return !!req.apiKeyInfo && !holdsApiKeyScope(req, FILES_WRITE_SCOPES);
}

export const FILES_READ_OR_WRITE_OR_GENERATE_SCOPES: ApiKeyScope[] = [
  ...FILES_READ_OR_WRITE_SCOPES,
  ApiKeyScope.AI_GENERATE,
];

export { GENERATE_UPLOAD_MARKER } from '@bike4mind/server-utils/files/generateUploadMarker';

/** True for an API key holding `ai:generate` but not `files:write`; a JWT caller is never bare. */
export function isBareGenerateUpload(req: ScopedRequest): boolean {
  return (
    !!req.apiKeyInfo && !holdsApiKeyScope(req, FILES_WRITE_SCOPES) && holdsApiKeyScope(req, [ApiKeyScope.AI_GENERATE])
  );
}

/** Keys that never fit the narrow forms above get the same 403 the files scope gate gives. */
export function throwFilesWriteRequired(): never {
  throw new ForbiddenError('This API key is read-only for files; files:write is required', {
    required_scopes: FILES_WRITE_SCOPES,
  });
}

export function assertFilesReadScope(req: ScopedRequest): void {
  assertApiKeyScope(req, FILES_READ_SCOPES, 'This API key cannot read files; files:read is required');
}

export function assertFilesWriteScope(req: ScopedRequest): void {
  assertApiKeyScope(req, FILES_WRITE_SCOPES, 'This API key is read-only for files; files:write is required');
}
