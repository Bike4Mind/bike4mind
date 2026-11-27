import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  AuthoredFunctionDetailResponseSchema,
  AuthoredFunctionResponseSchema,
  CreateFunctionRequestSchema,
  FunctionAuthoringErrorSchema,
  FunctionCallSummaryResponseSchema,
  FunctionDataNameParamSchema,
  FunctionPromotionResponseSchema,
  FunctionRecipientQuerySchema,
  FunctionRecipientResponseSchema,
  FunctionShareResponseSchema,
  FunctionTestRunResponseSchema,
  ListAuthoredFunctionsResponseSchema,
  PinFunctionDataRequestSchema,
  PromoteFunctionRequestSchema,
  RunFunctionTestsRequestSchema,
  SaveFunctionCodeRequestSchema,
  SetFunctionExamplesRequestSchema,
  SetFunctionSourcesRequestSchema,
  ShareFunctionRequestSchema,
  UpdateFunctionRequestSchema,
} from '../../schemas/functionsAuthoring';
import { FunctionIdParamSchema } from '../../schemas/functionsPublic';
import { PaginationQuerySchema } from '../../schemas/pagination';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * Authoring the key owner's own functions over the public API: write, test, pin data, promote, and share. Every route
 * names the confined scope `functions:author`, which calls nothing; calling stays `functions:invoke`
 * (functions.contract.ts). Routes: apps/client/pages/api/v1/functions. Each calls the service the app's
 * pages/api/callable-functions route calls.
 */

const SCOPES = [ApiKeyScope.FUNCTIONS_AUTHOR];

const FORBIDDEN =
  'The API key lacks `functions:author`, or callable functions are turned off for the key owner or one of their ' +
  'organizations.';

const NOT_FOUND =
  "No function with that id belongs to the key owner. A function shared with them and another person's function " +
  'answer this same 404.';

const RATE_LIMITED = 'Per-user rate limit exceeded. Honor `Retry-After`.';

const BODY_422 = 'The body does not fit the request schema.';

const CODE_400 =
  'The code or its contract was refused: `code` is `source_too_large`, `no_entry_point`, `invalid_contract` (with ' +
  '`problems`), or `invalid_name`.';

const STALE_409 =
  'The function changed since you read it (`code: "version_changed"`). Read it again and resend with the new ' +
  '`pin_version`.';

const RUNTIME_503 =
  'No function runtime is available here (`runtime_unavailable`), or it is starting (`runtime_starting`). Try ' +
  'again in a minute.';

const codeSample = { authToken: 'b4m_live_<key>', streaming: false } as const;

const err = (description: string) => ({ description, schema: FunctionAuthoringErrorSchema });

const common = {
  tags: ['Functions'],
  auth: 'apiKeyOrJwt' as const,
  scopes: SCOPES,
  emitsRateLimitHeaders: true,
};

const base = {
  403: { description: FORBIDDEN, schema: ScopeForbiddenErrorSchema },
  429: { description: RATE_LIMITED, schema: ApiErrorSchema },
};

const owned = { ...base, 404: { description: NOT_FOUND, schema: ApiErrorSchema } };

const CODE_EXAMPLE = {
  code:
    'FUNCTION = {"name": "beam_midspan_deflection", "description": "Midspan deflection of a simply supported ' +
    'beam.", "inputs": {...}, "outputs": {...}, "tests": [...]}\n\ndef run(inputs):\n    ...\n',
  contract: { name: 'beam_midspan_deflection', description: 'Midspan deflection of a simply supported beam.' },
};

export const createFunctionContract = defineEndpoint({
  ...common,
  method: 'post',
  path: '/api/v1/functions',
  operationId: 'createFunction',
  summary: 'Create a draft function',
  description:
    'Saves `code` as a new Python artifact of the key owner and pins it as a draft function. Run its tests and ' +
    'promote it to make it live. The name in `contract` is fixed from here on.',
  request: CreateFunctionRequestSchema,
  requestExample: CODE_EXAMPLE,
  responses: {
    201: { description: 'The draft, with its code.', schema: AuthoredFunctionDetailResponseSchema },
    400: err(CODE_400),
    403: base[403],
    409: err(
      'A function of the key owner already has that name (`functionId` names it), or the owner has as many ' +
        'functions as an account may keep.'
    ),
    422: err(BODY_422),
    429: base[429],
  },
  codeSample: { ...codeSample, body: CODE_EXAMPLE },
});

export const listAuthoredFunctionsContract = defineEndpoint({
  ...common,
  method: 'get',
  path: '/api/v1/functions/mine',
  operationId: 'listAuthoredFunctions',
  summary: 'List your functions in every state',
  description:
    "Lists the key owner's own functions: drafts, live, and turned off, without their code. Cursor-paginated: pass " +
    '`next_cursor` back as `cursor` until it is `null`.',
  queryParams: PaginationQuerySchema,
  responses: {
    200: { description: 'One page of functions.', schema: ListAuthoredFunctionsResponseSchema },
    ...base,
    422: { description: '`limit` is out of range, or `cursor` is malformed.', schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const getAuthoredFunctionContract = defineEndpoint({
  ...common,
  method: 'get',
  path: '/api/v1/functions/{id}/source',
  operationId: 'getAuthoredFunction',
  summary: 'Read your function with its code',
  description:
    'Returns one of your own functions in any state with its pinned code, its stored contract, its examples, ' +
    'data, sources, and share, and the run of its last promotion.',
  pathParams: FunctionIdParamSchema,
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionDetailResponseSchema },
    ...owned,
  },
  codeSample: { ...codeSample, body: {} },
});

export const saveFunctionCodeContract = defineEndpoint({
  ...common,
  method: 'put',
  path: '/api/v1/functions/{id}/code',
  operationId: 'saveFunctionCode',
  summary: 'Save new code for your function',
  description:
    'Writes `code` as a new version of the function artifact and pins it, which returns the function to draft. ' +
    'A live function stays callable at its last promotion until you promote it again. The name cannot change, and ' +
    'a contract that would break callers of the promoted one is refused.',
  pathParams: FunctionIdParamSchema,
  request: SaveFunctionCodeRequestSchema,
  requestExample: { ...CODE_EXAMPLE, pin_version: 3 },
  responses: {
    200: { description: 'The function at its new pin, with its code.', schema: AuthoredFunctionDetailResponseSchema },
    400: err(CODE_400),
    ...owned,
    409: err(
      `${STALE_409} Also: the name changed (\`name_changed\`), or the contract breaks the promoted one ` +
        '(`breaking_change`, with the changes).'
    ),
    422: err(BODY_422),
  },
  codeSample: { ...codeSample, body: { ...CODE_EXAMPLE, pin_version: 3 } },
});

export const updateFunctionContract = defineEndpoint({
  ...common,
  method: 'patch',
  path: '/api/v1/functions/{id}',
  operationId: 'updateFunction',
  summary: 'Turn your function on or off, or set its chat approval',
  description:
    'Sets one setting. `enabled: false` turns the function off: nobody can call it, and it stays saved and shared ' +
    'for when you turn it back on.',
  pathParams: FunctionIdParamSchema,
  request: UpdateFunctionRequestSchema,
  requestExample: { enabled: false },
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    ...owned,
    422: err(BODY_422),
  },
  codeSample: { ...codeSample, body: { enabled: false } },
});

export const deleteFunctionContract = defineEndpoint({
  ...common,
  method: 'delete',
  path: '/api/v1/functions/{id}',
  operationId: 'deleteFunction',
  summary: 'Delete your function',
  description:
    'Deletes the function with its pinned code, data files, and shares. Its artifact and the files its data came ' +
    'from stay.',
  pathParams: FunctionIdParamSchema,
  responses: {
    204: { description: 'Deleted.' },
    ...owned,
  },
  codeSample: { ...codeSample, body: {} },
});

export const setFunctionExamplesContract = defineEndpoint({
  ...common,
  method: 'put',
  path: '/api/v1/functions/{id}/examples',
  operationId: 'setFunctionExamples',
  summary: 'Replace the worked examples of your function',
  description:
    'Saves every worked example, each checked against the contract as a declared test is. A promotion runs them ' +
    'on the server, and one passing cited example makes the function `verified`. Changing the examples of a live ' +
    'function makes it `unverified` until the next promotion.',
  pathParams: FunctionIdParamSchema,
  request: SetFunctionExamplesRequestSchema,
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    400: err('`code` is `invalid_examples` (with `problems`) or `too_many_examples`.'),
    ...owned,
    409: err(STALE_409),
    422: err(BODY_422),
  },
  codeSample: { ...codeSample, body: { examples: [] } },
});

export const runFunctionTestsContract = defineEndpoint({
  ...common,
  method: 'post',
  path: '/api/v1/functions/{id}/test-runs',
  operationId: 'runFunctionTests',
  summary: 'Run the tests of your function on the server',
  description:
    'Runs the tests the pinned code declares on the server, one call each, within 45 s. The tests come from the ' +
    "server's own read of the code. A passing case is kept for the next promotion; cases the budget did not reach " +
    'come back `not_run`, so send their names in `tests` to run them.',
  pathParams: FunctionIdParamSchema,
  request: RunFunctionTestsRequestSchema,
  responses: {
    200: { description: 'Each case and how it ended.', schema: FunctionTestRunResponseSchema },
    400: err('`code` is `no_tests`, or `unknown_test` with the unknown `names`.'),
    ...owned,
    409: err('The stored contract does not match the pinned code. Save the code again.'),
    422: err(`${BODY_422} Also: the server could not read the contract from the code.`),
    503: err(RUNTIME_503),
  },
  codeSample: { ...codeSample, body: {} },
});

export const pinFunctionDataContract = defineEndpoint({
  ...common,
  method: 'post',
  path: '/api/v1/functions/{id}/data',
  operationId: 'pinFunctionData',
  summary: 'Pin a data file to your function',
  description:
    'Copies a file you uploaded into the function, read at `/data/<name>` on every call. Pinning returns the ' +
    'function to draft.',
  pathParams: FunctionIdParamSchema,
  request: PinFunctionDataRequestSchema,
  requestExample: { file_id: '<file-id>', name: 'table.csv' },
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    400: err('The name, the file, or its size was refused; `code` names which.'),
    ...owned,
    409: err('The name is taken (`data_name_taken`), the file is still being scanned, or the function has 10 files.'),
    422: err(BODY_422),
  },
  codeSample: { ...codeSample, body: { file_id: '<file-id>', name: 'table.csv' } },
});

export const unpinFunctionDataContract = defineEndpoint({
  ...common,
  method: 'delete',
  path: '/api/v1/functions/{id}/data/{name}',
  operationId: 'unpinFunctionData',
  summary: 'Unpin a data file from your function',
  description: 'Removes a pinned data file, which returns the function to draft. The file you uploaded stays.',
  pathParams: FunctionDataNameParamSchema,
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    ...base,
    404: { description: `${NOT_FOUND} Also: no data file has that name.`, schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const setFunctionSourcesContract = defineEndpoint({
  ...common,
  method: 'put',
  path: '/api/v1/functions/{id}/sources',
  operationId: 'setFunctionSources',
  summary: 'Replace the sources of your function',
  description:
    'Saves every source: an https URL on an origin an administrator allowed, read at `/data/<name>`. A `live` ' +
    'source is fetched on each call, a `pinned` one once at promotion. A change returns the function to draft.',
  pathParams: FunctionIdParamSchema,
  request: SetFunctionSourcesRequestSchema,
  requestExample: { sources: [{ name: 'feed.json', url: 'https://data.example.com/feed.json', mode: 'live' }] },
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    400: err('A name, URL, mode, or origin was refused; `code` names which.'),
    ...owned,
    409: err(`The name is taken (\`data_name_taken\`), or there are too many sources. ${STALE_409}`),
    422: err(BODY_422),
  },
  codeSample: {
    ...codeSample,
    body: { sources: [{ name: 'feed.json', url: 'https://data.example.com/feed.json', mode: 'live' }] },
  },
});

export const promoteFunctionContract = defineEndpoint({
  ...common,
  method: 'post',
  path: '/api/v1/functions/{id}/promote',
  operationId: 'promoteFunction',
  summary: 'Promote your function to live',
  description:
    'Makes the function live once every declared test and worked example has passed on the server on this pin. ' +
    'Passes from earlier test runs are reused and the rest run within 45 s. Anyone the function is shared with ' +
    'calls the new promotion.',
  pathParams: FunctionIdParamSchema,
  request: PromoteFunctionRequestSchema,
  responses: {
    200: { description: 'The live function and the run.', schema: FunctionPromotionResponseSchema },
    400: err('The function declares no test and has no worked example (`no_cases`).'),
    ...owned,
    409: err(
      'A case failed, cases were left for the budget (`cases_left`; promote again), the runtime changed, the ' +
        'contract breaks the promoted one or does not match the code, a pinned source could not be fetched, or the ' +
        'function changed during the promotion. `code` names which.'
    ),
    422: err(`${BODY_422} Also: the server could not read the contract from the code.`),
    503: err(RUNTIME_503),
  },
  codeSample: { ...codeSample, body: {} },
});

export const getFunctionShareContract = defineEndpoint({
  ...common,
  method: 'get',
  path: '/api/v1/functions/{id}/share',
  operationId: 'getFunctionShare',
  summary: 'Read the share of your function',
  description: 'Returns who the function is shared with, and the display names of the people named.',
  pathParams: FunctionIdParamSchema,
  responses: {
    200: { description: 'The share; `share` is null when it was never shared.', schema: FunctionShareResponseSchema },
    ...owned,
  },
  codeSample: { ...codeSample, body: {} },
});

export const shareFunctionContract = defineEndpoint({
  ...common,
  method: 'put',
  path: '/api/v1/functions/{id}/share',
  operationId: 'shareFunction',
  summary: 'Share your function',
  description:
    'Replaces the share of a live function: people by id, and a project or an organization you belong to. Each ' +
    'person reviews the function before calling it, and calls its last promotion. Removing someone also removes ' +
    'their review.',
  pathParams: FunctionIdParamSchema,
  request: ShareFunctionRequestSchema,
  requestExample: { visibility: 'private', user_ids: ['<user-id>'] },
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    400: err('`code` is `too_many_people`, `invalid_person`, or `no_recipients`.'),
    ...base,
    404: { description: `${NOT_FOUND} Also: the project or organization named.`, schema: ApiErrorSchema },
    409: err('The function is not live (`not_live`): promote it first.'),
    422: err(BODY_422),
  },
  codeSample: { ...codeSample, body: { visibility: 'private', user_ids: ['<user-id>'] } },
});

export const unshareFunctionContract = defineEndpoint({
  ...common,
  method: 'delete',
  path: '/api/v1/functions/{id}/share',
  operationId: 'unshareFunction',
  summary: 'Stop sharing your function',
  description: 'Removes every person, project, and organization from the share, and their reviews.',
  pathParams: FunctionIdParamSchema,
  responses: {
    200: { description: 'The function.', schema: AuthoredFunctionResponseSchema },
    ...owned,
  },
  codeSample: { ...codeSample, body: {} },
});

export const findFunctionRecipientContract = defineEndpoint({
  ...common,
  method: 'get',
  path: '/api/v1/functions/{id}/recipient',
  operationId: 'findFunctionRecipient',
  summary: 'Find a person to share your function with',
  description:
    'Returns the id and display name of the account holding exactly `email`, to name in a share. Limited to 20 ' +
    'lookups a minute.',
  pathParams: FunctionIdParamSchema,
  queryParams: FunctionRecipientQuerySchema,
  responses: {
    200: { description: 'The person, or null.', schema: FunctionRecipientResponseSchema },
    ...owned,
    422: { description: '`email` is missing.', schema: ApiErrorSchema },
  },
  codeSample: { ...codeSample, body: {} },
});

export const getFunctionCallSummaryContract = defineEndpoint({
  ...common,
  method: 'get',
  path: '/api/v1/functions/{id}/calls',
  operationId: 'getFunctionCallSummary',
  summary: 'Summarize the calls of your function',
  description:
    'Counts the calls of the last 30 days by outcome and lists the latest few, yours and those of the people it ' +
    'is shared with. Never the inputs or outputs, and never who a recipient is.',
  pathParams: FunctionIdParamSchema,
  responses: {
    200: { description: 'The summary.', schema: FunctionCallSummaryResponseSchema },
    ...owned,
  },
  codeSample: { ...codeSample, body: {} },
});
