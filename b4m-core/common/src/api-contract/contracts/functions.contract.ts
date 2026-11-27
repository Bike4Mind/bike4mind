import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { FUNCTION_REVIEW_REQUIRED_ERROR_CODE, REQUEST_TIMEOUT_ERROR_CODE } from '../../apiErrorCodes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  FunctionCallIdParamSchema,
  FunctionIdParamSchema,
  FunctionReviewErrorSchema,
  GetFunctionCallResponseSchema,
  GetFunctionResponseSchema,
  InvokeFunctionFailedErrorSchema,
  InvokeFunctionForbiddenErrorSchema,
  InvokeFunctionInputErrorSchema,
  InvokeFunctionQueuedResponseSchema,
  InvokeFunctionRequestSchema,
  InvokeFunctionResponseSchema,
  InvokeFunctionTimeoutErrorSchema,
  ListFunctionsResponseSchema,
  ReviewFunctionRequestSchema,
} from '../../schemas/functionsPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * The live functions the key owner reaches over the public API: their own and those shared with them. List, read,
 * review, and call. Every route names the confined scope `functions:invoke`. Routes:
 * apps/client/pages/api/v1/functions.
 */

const SCOPES = [ApiKeyScope.FUNCTIONS_INVOKE];

const FORBIDDEN =
  'The API key lacks `functions:invoke`, or callable functions are turned off for the key owner or one of ' +
  'their organizations.';

const NOT_FOUND =
  "No live function with that id is the key owner's or shared with them. A draft, a turned-off function, one " +
  "whose artifact was deleted, and another person's function not shared with them all answer this same 404.";

const REVIEW_NOT_FOUND =
  'No live function with that id is shared with the key owner. Their own function, a function not shared with ' +
  'them, and a missing id all answer this same 404.';

const RATE_LIMITED = 'Per-user rate limit exceeded. Honor `Retry-After`.';

const CALL_NOT_FOUND =
  "No call with that id was made by the key owner, or its result is more than 24 hours old. Another person's call " +
  'answers this same 404.';

const PAGE_422 =
  '`limit` is out of range, or `cursor` is malformed or was issued by a different endpoint. A cursor is opaque: ' +
  'pass back exactly the `next_cursor` you were given.';

const codeSample = { authToken: 'b4m_live_<key>', streaming: false } as const;

const INVOKE_EXAMPLE = { input: { load: 2000, span: 4, elastic_modulus: 70e9, second_moment: 1e-5 } };

export const listFunctionsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/functions',
  operationId: 'listFunctions',
  summary: 'List live functions',
  description:
    'Lists the live functions the key owner reaches: Python artifacts saved as functions and promoted after their ' +
    'tests passed on the server. `group` says whose each one is. A function shared with the key owner is listed ' +
    'before they review it, with `review_status: "needs_review"`, and can be called once it reads `allowed`. ' +
    'Drafts and turned-off functions are not listed. Cursor-paginated: pass `next_cursor` back as `cursor` until ' +
    'it is `null`.',
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  queryParams: PaginationQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'One page of functions.', schema: ListFunctionsResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    422: { description: PAGE_422, schema: ApiErrorSchema },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const getFunctionContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/functions/{id}',
  operationId: 'getFunction',
  summary: 'Get a live function',
  description:
    'Returns one live function with its contract: `input_schema` and `output_schema` are the JSON Schemas its ' +
    'inputs and outputs must fit, with each number field naming its `unit`. A function shared with the key owner ' +
    'reads the same before and after their review, with who shared it and the `review_hash` an allow sends back. ' +
    'Never the code or its data.',
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: FunctionIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The function.', schema: GetFunctionResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: NOT_FOUND, schema: ApiErrorSchema },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const invokeFunctionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/functions/{id}/invoke',
  operationId: 'invokeFunction',
  summary: 'Call a live function',
  description:
    'Runs one live function on the server with `input` and returns its `output` with a `stamp`: the function, ' +
    'pin, code hash, input hash, runtime, and packages the call ran on, so a result can be traced and repeated. ' +
    'The inputs are checked against `input_schema` before anything runs and the outputs against `output_schema` ' +
    'after. A call is synchronous by default and stops at 45 s. With `mode: "async"` every check is made first, ' +
    "then the call answers 202 with a `call_id`, runs to the organization's time limit, and keeps its result for " +
    '24 hours at `GET /api/v1/functions/calls/{call_id}`. Each call is logged with hashes and sizes only, never ' +
    'the inputs or outputs.',
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: FunctionIdParamSchema,
  request: InvokeFunctionRequestSchema,
  requestExample: INVOKE_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The call returned.', schema: InvokeFunctionResponseSchema },
    202: {
      description:
        'With `mode: "async"`: every check passed and the call is queued. Nothing ran yet; poll `call_id` for how ' +
        'it ends.',
      schema: InvokeFunctionQueuedResponseSchema,
      pollResult: {
        schema: GetFunctionCallResponseSchema,
        description:
          'Read at `GET /api/v1/functions/calls/{call_id}`. A call that ran and failed still polls as `200` with ' +
          '`status: "finished"`; check `outcome` before reading `output`.',
      },
    },
    403: {
      description:
        `${FORBIDDEN} Or, with \`errorCode: "${FUNCTION_REVIEW_REQUIRED_ERROR_CODE}"\`, the function was shared ` +
        'with the key owner and its `review_status` is not `allowed`: allow it with ' +
        '`POST /api/v1/functions/{id}/review`, then call again.',
      schema: InvokeFunctionForbiddenErrorSchema,
    },
    404: { description: NOT_FOUND, schema: ApiErrorSchema },
    413: { description: 'The request body or `input` is larger than a call accepts.', schema: ApiErrorSchema },
    422: {
      description:
        'The body is malformed, or `input` does not fit `input_schema`; `problems` names each field and why.',
      schema: InvokeFunctionInputErrorSchema,
    },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
    502: {
      description:
        'The function ran and failed: it raised an error (`outcome: "error"`), ran out of memory (`memory`), ' +
        'returned outputs that do not fit `output_schema` (`output_invalid`), or returned too much ' +
        '(`output_too_large`). `stamp` names what it ran on.',
      schema: InvokeFunctionFailedErrorSchema,
    },
    503: {
      description:
        'No function runtime is available, the runtime was slow to start or did not answer, or an asynchronous ' +
        'call could not be queued. Try again later.',
      schema: ApiErrorSchema,
    },
    504: {
      description:
        `The call ran past its time limit and was stopped (\`errorCode: "${REQUEST_TIMEOUT_ERROR_CODE}"\`). When ` +
        "the organization's limit is longer than the 45 s a synchronous call may take, `error` says to send " +
        '`mode: "async"`.',
      schema: InvokeFunctionTimeoutErrorSchema,
    },
  },
  codeSample: { ...codeSample, body: INVOKE_EXAMPLE },
});

const REVIEW_EXAMPLE = {
  action: 'allow',
  review_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

export const reviewFunctionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/functions/{id}/review',
  operationId: 'reviewFunction',
  summary: 'Allow a function shared with you, or withdraw the allow',
  description:
    "Records the key owner's review of a function another person shared with them, as the review in the app " +
    'does. `action: "allow"` with the `review_hash` read from `GET /api/v1/functions/{id}` lets them call it. ' +
    '`action: "withdraw"` takes the allow back, so calls are refused with `review_required` until they allow it ' +
    'again. Answers the function as `GET /api/v1/functions/{id}` reads it. Only a shared function can be ' +
    "reviewed: the key owner's own needs none.",
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: FunctionIdParamSchema,
  request: ReviewFunctionRequestSchema,
  requestExample: REVIEW_EXAMPLE,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The function after the review.', schema: GetFunctionResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: REVIEW_NOT_FOUND, schema: ApiErrorSchema },
    409: {
      description:
        'The interface changed since `review_hash` was read (`code: "review_conflict"`): read the function again ' +
        'and allow the new hash. Or a withdraw of a function never allowed (`code: "not_reviewed"`).',
      schema: FunctionReviewErrorSchema,
    },
    422: { description: 'The body does not fit the request schema.', schema: ApiErrorSchema },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: REVIEW_EXAMPLE },
});

export const getFunctionCallContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/functions/calls/{call_id}',
  operationId: 'getFunctionCall',
  summary: 'Poll an asynchronous function call',
  description:
    'Reads an asynchronous call: `queued`, `running`, or `finished` with its `outcome`, `output`, and `stamp`. ' +
    'Only the person whose key made the call can read it, and a result is kept 24 hours.',
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: FunctionCallIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The call as it stands.', schema: GetFunctionCallResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: CALL_NOT_FOUND, schema: ApiErrorSchema },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const cancelFunctionCallContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/functions/calls/{call_id}/cancel',
  operationId: 'cancelFunctionCall',
  summary: 'Cancel an asynchronous function call',
  description:
    'Cancels an asynchronous call that is `queued` or `running` and returns it as `finished` with `outcome: ' +
    '"cancelled"`. A queued call never runs. A running call is left to end, but what it returns is discarded and ' +
    'never polled. A call that already finished is returned unchanged. Only the person whose key made the call ' +
    'can cancel it.',
  tags: ['Functions'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  pathParams: FunctionCallIdParamSchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: { description: 'The call after the cancel.', schema: GetFunctionCallResponseSchema },
    403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
    404: { description: CALL_NOT_FOUND, schema: ApiErrorSchema },
    429: { description: RATE_LIMITED, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});
