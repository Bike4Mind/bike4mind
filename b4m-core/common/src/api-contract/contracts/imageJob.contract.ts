import { defineEndpoint } from '../defineEndpoint';
import {
  BILLING_ORGANIZATION_FORBIDDEN_DESCRIPTION,
  BILLING_ORGANIZATION_STALE_KEY_DESCRIPTION,
} from '../../schemas/billingOrganization';
import { EXAMPLE_GROUP_ID, EXAMPLE_RESOURCE_ID } from '../exampleIds';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  ApiErrorSchema,
  BillingOrganizationForbiddenErrorSchema,
  ScopeForbiddenErrorSchema,
  StorageLimitErrorSchema,
} from '../../schemas/chat';
import {
  CreateImageJobBodySchema,
  CreateImageJobResponseSchema,
  ImageJobErrorResponseSchema,
  ImageJobIdParamSchema,
  ImageJobSchema,
  ListImageJobsQuerySchema,
  ListImageJobsResponseSchema,
} from '../../schemas/imageJobs';

// The async job resource. The legacy quest-based POST /api/v1/image-generations and /api/v1/image-edits live in
// imageGeneration.contract.ts and imageEdit.contract.ts, deprecated in its favour.

const examplePrompt = 'A watercolor lighthouse at dusk';

const exampleJob = {
  id: EXAMPLE_RESOURCE_ID,
  object: 'image_generation',
  state: 'pending',
  model: 'gpt-image-1',
  mode: 'generate',
  prompt: examplePrompt,
  group_id: EXAMPLE_GROUP_ID,
  source: 'api',
  error: null,
  output: null,
  credits: { reserved: 12, settled: null },
  created_at: '2026-11-17T00:00:00.000Z',
  updated_at: '2026-11-17T00:00:00.000Z',
} as const;

const exampleBody = { model: 'gpt-image-1', mode: 'generate', prompt: examplePrompt, size: '1024x1024' } as const;

const scopeForbidden = { description: 'The API key lacks the `ai:generate` scope.', schema: ScopeForbiddenErrorSchema };
const notFound = {
  description: 'No image job with that id was requested by the caller (a malformed id is also a 404).',
  schema: ApiErrorSchema,
};
const rateLimited = { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema };

export const createImageJobContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/image-jobs',
  operationId: 'createImageJob',
  summary: 'Start an image generation or edit',
  description:
    'Queues `count` images (default 1), one job each, and returns `202` with the jobs and their shared ' +
    '`group_id`. Poll `GET /api/v1/image-jobs/{id}` for each job until `state` is `succeeded`, `failed`, ' +
    '`blocked` or `cancelled`. `mode: "generate"` renders from the prompt; `mode: "edit"` changes the ' +
    '`edit_source` input, optionally within a `mask` or `edit_regions`. Input images are files you uploaded ' +
    '(`POST /api/v1/files`). The prompt is sent as written. Check the request against the model in ' +
    '`GET /api/v1/image-models`: an unsupported size, aspect ratio, quality, input or option is a 422 naming ' +
    'it, never silently adjusted. A finished image is saved to your Files with the `generated` tag (if that ' +
    'save fails it is kept outside Files and `output.file_id` is null). On success, `output.availability` says ' +
    'whether it can be downloaded: `ready` means `output.url` is a signed download URL valid for 15 minutes ' +
    '(re-fetch the job for a fresh one); `pending_scan` means the saved file is still being scanned, so keep ' +
    're-fetching the job; `unavailable` means the file was blocked or deleted, so stop polling. ' +
    "Credits for the model's price are reserved up front per image and settled on completion; a failed or " +
    'cancelled job is not charged. A `blocked` job is not charged either, unless the provider rendered the ' +
    'image before it was rejected and billed it: then `credits.settled` shows the charge. ' +
    'Send an `Idempotency-Key` header (1-255 printable ASCII characters) to make retries safe: a repeat with ' +
    'the same key and body returns the original jobs, and the same key with a different body is a 422 ' +
    '`idempotency_key_reused`. Keys are scoped to the billed account and to `count`, so the same key sent ' +
    'with a different `count` or `organization_id` starts new jobs, which are charged. Set `organization_id` ' +
    'to bill an organization you belong to, or `null` to bill ' +
    'your personal credits; omitted, the jobs bill your home organization (or your personal credits if you ' +
    'have none). An organization-billed API key always bills its own organization (see `organization_id`). ' +
    'This replaces `POST /api/v1/image-generations` and `POST /api/v1/image-edits`.',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateImageJobBodySchema,
  requestExample: exampleBody,
  responses: {
    202: {
      description: 'Accepted; the jobs are queued (or replayed for a repeated Idempotency-Key).',
      schema: CreateImageJobResponseSchema,
      example: { group_id: EXAMPLE_GROUP_ID, data: [exampleJob] },
    },
    400: {
      description:
        'Your Files storage has no room for the images (`storage_limit_exceeded`, as on the Files upload ' +
        'routes). The body carries `used_bytes`, `limit_bytes`, `requested_bytes` and `owner`, always together; ' +
        '`requested_bytes` is an upper estimate, not the final size. ' +
        BILLING_ORGANIZATION_STALE_KEY_DESCRIPTION,
      schema: StorageLimitErrorSchema,
    },
    403: {
      description:
        `The API key lacks the \`ai:generate\` scope, the model is not allowed for you or your organization, or ` +
        BILLING_ORGANIZATION_FORBIDDEN_DESCRIPTION,
      schema: BillingOrganizationForbiddenErrorSchema,
    },
    404: {
      description:
        'The `run` does not exist or another user or billing owner minted it (`errorCode: run_not_found`). A ' +
        'nonexistent `organization_id` is `404` only for an admin caller; for anyone else it is `403`.',
      schema: ImageJobErrorResponseSchema,
    },
    422: {
      description:
        'The request cannot run: a malformed body (`invalid_request`), something the model does not honour ' +
        '(`errorCode` names the first, e.g. `unsupported_size` or `missing_input`; `message` lists them all), an ' +
        'unknown or unavailable model (`model_unavailable`), an input file that is not yours or not found ' +
        '(`input_image_not_found`) or not a usable image (`unsupported_input_image`), too few credits ' +
        '(`insufficient_credits`), a `run` budget with too little left for every job (`run_budget_exhausted`), ' +
        'or an Idempotency-Key problem (`invalid_idempotency_key`, `idempotency_key_reused`). An API key ' +
        'without `files:read` may only name generated images and images staged by an `ai:generate` key ' +
        'without `files:write`; any other file is `input_image_not_found`.',
      schema: ImageJobErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: exampleBody },
});

export const getImageJobContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/image-jobs/{id}',
  operationId: 'getImageJob',
  summary: 'Get an image job',
  description:
    'Returns one job you requested. Each read signs a fresh `output.url` (valid 15 minutes, see `expires_at`).',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: ImageJobIdParamSchema,
  responses: {
    200: { description: 'The job.', schema: ImageJobSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const listImageJobsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/image-jobs',
  operationId: 'listImageJobs',
  summary: 'List your image jobs',
  description:
    'Your image jobs from every surface (this API, Studio and chat), newest first, optionally filtered by ' +
    '`state` and `source`. Cursor-paginated (see the pagination convention): pass `next_cursor` back as ' +
    '`cursor` until it is `null`.',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  queryParams: ListImageJobsQuerySchema,
  responses: {
    200: { description: 'A page of jobs.', schema: ListImageJobsResponseSchema },
    403: scopeForbidden,
    422: { description: 'A malformed `cursor`, `limit`, `state` or `source`.', schema: ApiErrorSchema },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});

export const cancelImageJobContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/image-jobs/{id}/cancel',
  operationId: 'cancelImageJob',
  summary: 'Cancel an image job',
  description:
    'Requests cancellation and returns the job. A job still `pending` moves to `cancelled` shortly after and ' +
    'its reserved credits are returned. Most models render an image in one provider call that cannot be ' +
    'interrupted and is billed once it starts, so a `running` job of such a model is refused with a 409 ' +
    '(`not_cancellable`) and runs to its end. A finished job is returned unchanged.',
  tags: ['Images'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: ImageJobIdParamSchema,
  responses: {
    200: { description: 'The job after the cancel request.', schema: ImageJobSchema, example: exampleJob },
    403: scopeForbidden,
    404: notFound,
    409: {
      description: 'The image is already rendering (`running`); `errorCode` is `not_cancellable`.',
      schema: ImageJobErrorResponseSchema,
    },
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
