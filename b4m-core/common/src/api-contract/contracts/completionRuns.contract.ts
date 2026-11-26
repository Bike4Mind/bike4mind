import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  ApiErrorSchema,
  CompletionRunForbiddenErrorSchema,
  RunBudgetNotRaisedErrorSchema,
  RunNotFoundErrorSchema,
} from '../../schemas/chat';
import {
  CompletionRunIdParamSchema,
  CompletionRunOwnerQuerySchema,
  CompletionRunSchema,
  CompletionRunUsageSchema,
  CreateCompletionRunRequestSchema,
  RaiseCompletionRunBudgetRequestSchema,
  CompletionEvaluationStateSchema,
} from '../../schemas/cliCompletions';

/**
 * Contract for POST /api/v1/completion-runs - mints the run id that `POST /api/ai/v1/completions`
 * accepts as `run`. Same auth and scopes as completions, since every caller of one needs the other.
 */
export const createCompletionRunContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/completion-runs',
  operationId: 'createCompletionRun',
  summary: 'Create a completion run',
  description:
    'Mints a run id that groups the spend of several `POST /api/ai/v1/completions` requests, such as a ' +
    'root session and the workers it spawns. Send the returned `runId` as `run.runId` on each of those ' +
    'requests. The run is bound to the credential that minted it: the same user and the same billing owner ' +
    '(the organization for an organization-billed API key or the `organization_id` sent, otherwise the user), and a completion naming a run ' +
    'minted by anyone else is refused with `404` (`errorCode: "run_not_found"`). Minting a run charges nothing, ' +
    'and attributing a completion to it never charges that completion twice.\n\n' +
    'With `budgetCredits`, the run also caps admission: what its completions may claim together. Before calling the ' +
    'model, each completion claims what its first round can cost at its full output budget (less, down to ' +
    'what a short answer costs, when the run has less left) and is capped to that claim, so concurrent ' +
    'completions can never together be admitted past the budget. The claim is priced from an estimate of ' +
    'the input, so a completion that costs more than it claimed is still charged its actual cost, up to what the ' +
    'balance can pay; the run counts that cost and refuses later claims it can no longer cover. A run can ' +
    'go over its budget by at most that miss for each completion in flight. A completion that runs ' +
    'server-side tools claims more the same way before each further round, and ends with ' +
    '`stopReason: "max_tokens"` when the run cannot cover one. A completion the budget cannot ' +
    'cover is refused with `422` (`errorCode: "run_budget_exhausted"`) before anything is charged. Claims ' +
    'return to the run when their completion settles, fails or is abandoned. The account balance and any ' +
    'organization member caps still apply on their own, and buying credits does not raise a run budget. ' +
    'The budget bounds charged credits, so a deployment that does not charge for completions counts nothing ' +
    'against it.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: CreateCompletionRunRequestSchema,
  requestExample: { rootSessionId: 'session-42', budgetCredits: 5000 },
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description:
        'The created run, or the existing evaluation for the same owner and rootSessionId. Evaluation mint retries preserve the original immutable limits and receipts.',
      schema: CompletionRunSchema,
      example: {
        runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
        rootSessionId: 'session-42',
        budgetCredits: 5000,
        createdAt: '2026-11-10T12:00:00.000Z',
      },
    },
    400: { description: 'Evaluation requires a stable rootSessionId.', schema: ApiErrorSchema },
    403: {
      description:
        'Evaluation execution is not enabled for this account; an organization-billed API key named another `organization_id` (`errorCode: "billing_organization_mismatch"`); or the caller cannot use the named organization.',
      schema: CompletionRunForbiddenErrorSchema,
    },
    409: {
      description: 'The evaluation identity already exists with different limits or models.',
      schema: ApiErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { rootSessionId: 'session-42', budgetCredits: 5000 },
  },
});

/**
 * Contract for POST /api/v1/completion-runs/{runId}/budget - raises a budgeted run's ceiling, the
 * explicit step a client takes to resume a run its budget stopped. Same auth, scopes and ownership
 * rule as minting the run.
 */
export const raiseCompletionRunBudgetContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/completion-runs/{runId}/budget',
  operationId: 'raiseCompletionRunBudget',
  summary: "Raise a completion run's budget",
  description:
    'Sets a higher `budgetCredits` on a run minted with one, so completions refused with ' +
    '`errorCode: "run_budget_exhausted"` can be admitted again. A budget is only ever raised: a value at or ' +
    'below the current budget, or a run minted without a budget, is refused with `409` ' +
    '(`errorCode: "run_budget_not_raised"`). Raising it charges nothing, and buying credits never raises it. ' +
    'Only a credential of the same user and billing owner that minted the run can raise it; any other run id, ' +
    'including one that does not exist, gets `404` (`errorCode: "run_not_found"`).',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: CompletionRunIdParamSchema,
  request: RaiseCompletionRunBudgetRequestSchema,
  requestExample: { budgetCredits: 8000 },
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The run with its raised budget.',
      schema: CompletionRunSchema,
      example: {
        runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
        rootSessionId: 'session-42',
        budgetCredits: 8000,
        createdAt: '2026-11-10T12:00:00.000Z',
      },
    },
    403: {
      description:
        'An organization-billed API key named another `organization_id` (`errorCode: "billing_organization_mismatch"`), or the caller cannot use the named organization.',
      schema: CompletionRunForbiddenErrorSchema,
    },
    404: {
      description: 'The run does not exist, or another user or billing owner minted it (`errorCode: "run_not_found"`).',
      schema: RunNotFoundErrorSchema,
    },
    409: {
      description:
        'The new budget is not above the current one, or the run was minted without a budget (`errorCode: "run_budget_not_raised"`).',
      schema: RunBudgetNotRaisedErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: { budgetCredits: 8000 } },
});

export const getCompletionRunEvaluationContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/completion-runs/{runId}/evaluation',
  operationId: 'getCompletionRunEvaluation',
  summary: 'Recover evaluation admission receipts',
  description:
    'Owner-scoped durable provider-priced reservations and receipts. Pending and unknown receipts retain their full bounds and block further admission. Provider-priced USD is distinct from platform credit charges. A complete receipt uses provider-reported usage and the immutable catalog rates captured at admission; it is not an invoice. Recovery never repeats a provider dispatch.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: CompletionRunIdParamSchema,
  queryParams: CompletionRunOwnerQuerySchema,
  responses: {
    200: { description: 'Evaluation state and durable request receipts.', schema: CompletionEvaluationStateSchema },
    403: {
      description:
        'An organization-billed API key named another `organization_id` (`errorCode: "billing_organization_mismatch"`), or the caller cannot use the named organization.',
      schema: CompletionRunForbiddenErrorSchema,
    },
    404: { description: 'Evaluation run not found for this owner.', schema: RunNotFoundErrorSchema },
    429: { description: 'Rate limit exceeded.', schema: ApiErrorSchema },
  },
});

const EXAMPLE_SPEND = {
  creditsCharged: 412,
  requests: 9,
  inputTokens: 18200,
  outputTokens: 4100,
  cacheReadTokens: 52000,
  cacheWriteTokens: 6400,
};

/**
 * Contract for GET /api/v1/completion-runs/{runId}/usage - the settled spend of one run, read from the
 * ledger rows its completions wrote. Same auth, scopes and ownership rule as minting the run.
 */
export const getCompletionRunUsageContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/completion-runs/{runId}/usage',
  operationId: 'getCompletionRunUsage',
  summary: "Get a completion run's spend",
  description:
    'Returns what a run has cost so far: every `POST /api/ai/v1/completions` request sent with this `run.runId` ' +
    'whose credits have settled, summed once per request from the credit ledger, with breakdowns by role, purpose, ' +
    "model and task attempt. `creditsCharged` is the sum of the amounts each request's `settled` stream event reports, so a " +
    'client can reconcile its own totals against it. Only settled charges count: a request still running, one whose ' +
    'credits never settled, and one sent without `run` are not included. Readable only with a credential of the ' +
    'same user and billing owner that minted the run; any other run id, including one that does not exist, ' +
    'gets `404` (`errorCode: "run_not_found"`).\n\n' +
    'A run minted with a budget also returns `budget`: the ceiling, what is committed against it (settled ' +
    'charges plus the claims of completions still running), the unsettled part of that, and what is left.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: CompletionRunIdParamSchema,
  queryParams: CompletionRunOwnerQuerySchema,
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The run and its settled spend.',
      schema: CompletionRunUsageSchema,
      example: {
        runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
        rootSessionId: 'session-42',
        createdAt: '2026-11-10T12:00:00.000Z',
        settled: EXAMPLE_SPEND,
        byRole: [{ role: 'root', ...EXAMPLE_SPEND }],
        byPurpose: [{ purpose: 'turn', ...EXAMPLE_SPEND }],
        byModel: [{ model: 'claude-sonnet-5-5', ...EXAMPLE_SPEND }],
        byAttempt: [{ role: 'root', ...EXAMPLE_SPEND }],
        byAttemptTruncated: false,
        budget: { budgetCredits: 5000, committedCredits: 1012, reservedCredits: 600, remainingCredits: 3988 },
      },
    },
    403: {
      description:
        'An organization-billed API key named another `organization_id` (`errorCode: "billing_organization_mismatch"`), or the caller cannot use the named organization.',
      schema: CompletionRunForbiddenErrorSchema,
    },
    404: {
      description: 'The run does not exist, or another user or billing owner minted it (`errorCode: "run_not_found"`).',
      schema: RunNotFoundErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
