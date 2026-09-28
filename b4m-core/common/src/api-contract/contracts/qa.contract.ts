import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { ApiErrorSchema } from '../../schemas/chat';
import {
  QaRunIngestRequestSchema,
  QaRunIngestResponseSchema,
  QaUploadRequestSchema,
  QaUploadResponseSchema,
} from '../../schemas/qa';

/**
 * CI ingest for the admin /status page. Both routes 401 a JWT caller and 403 a key
 * whose owner lacks the `qa-ingest` user tag, on top of the scope gate - see
 * apps/client/server/qa/requireQaIngestKey.ts.
 */
const AUTH_ERRORS = {
  401: { description: 'Missing or invalid API key. JWT callers are rejected.', schema: ApiErrorSchema },
  403: { description: 'Key lacks qa:ingest, or its owner lacks the qa-ingest tag.', schema: ApiErrorSchema },
} as const;

const runExample = {
  product: 'product-a',
  suite: 'Core',
  env: 'staging',
  branch: 'main',
  trigger: 'Run via Deployer',
  ci_run_url: 'https://github.com/example/repo/actions/runs/100',
  started_at: '2026-09-28T09:00:00.000Z',
  duration_ms: 252000,
  counts: { passed: 81, failed: 2, skipped: 0, not_started: 0, ran: 83, total: 83 },
  external_run_id: '100-1',
};

const uploadsExample = {
  product: 'product-a',
  external_run_id: '100-1',
  files: [{ path: 'test-3/screenshot.png', kind: 'screenshot', content_type: 'image/png', bytes: 120000 }],
};

/** Handler: apps/client/pages/api/v1/qa/runs.ts. Caller: scripts/qa-report.mjs. */
export const ingestQaRunContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/qa/runs',
  operationId: 'ingestQaRun',
  summary: 'Ingest a Playwright run',
  description:
    'Upserts one end-to-end run by `external_run_id` and replaces its test results. Status is derived ' +
    'server-side from `counts`. Re-sending the same `external_run_id` is idempotent. A 422 also covers an ' +
    'artifact key or `report_prefix` outside `<product>/<external_run_id>/`.',
  tags: ['QA'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.QA_INGEST],
  request: QaRunIngestRequestSchema,
  requestExample: runExample,
  // Served by baseApi (via nextRouteForContract), so apiKeyRateLimit sets the windowed headers.
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'Run stored. `created` is false on a re-ingest.', schema: QaRunIngestResponseSchema },
    ...AUTH_ERRORS,
    429: { description: 'Per-key rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: runExample },
});

/** Handler: apps/client/pages/api/v1/qa/uploads.ts. Caller: scripts/qa-report.mjs. */
export const requestQaUploadsContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/qa/uploads',
  operationId: 'requestQaUploads',
  summary: 'Presign QA artifact uploads',
  description:
    'Returns a presigned PUT URL per file, scoped to `<product>/<external_run_id>/{media,report}/`. ' +
    'Each URL is bound to the declared content type and byte size. Files over the per-kind cap, of a ' +
    'disallowed type, or with an unsafe path are listed in `rejected` and get no URL.',
  tags: ['QA'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.QA_INGEST],
  request: QaUploadRequestSchema,
  requestExample: uploadsExample,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'Upload URLs, plus any rejected files with the reason.', schema: QaUploadResponseSchema },
    ...AUTH_ERRORS,
    429: { description: 'Per-key rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: uploadsExample },
});
