import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { ApiErrorSchema, RunNotFoundErrorSchema } from '../../schemas/chat';
import {
  CompletionRunIdParamSchema,
  CompletionRunSchema,
  CompletionRunUsageSchema,
  CreateCompletionRunRequestSchema,
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
    '(the organization for an organization-billed API key, otherwise the user), and a completion naming a run ' +
    'minted by anyone else is refused with `404` (`errorCode: "run_not_found"`). Minting a run charges nothing, ' +
    'and attributing a completion to it never charges that completion twice.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  request: CreateCompletionRunRequestSchema,
  requestExample: { rootSessionId: 'session-42' },
  emitsRateLimitHeaders: true,
  responses: {
    201: {
      description: 'The created run.',
      schema: CompletionRunSchema,
      example: {
        runId: '0b6f3c2e-7d4a-4f51-9a8e-2c1d5e6f7a80',
        rootSessionId: 'session-42',
        createdAt: '2026-11-10T12:00:00.000Z',
      },
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { rootSessionId: 'session-42' },
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
    'gets `404` (`errorCode: "run_not_found"`).',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  pathParams: CompletionRunIdParamSchema,
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
      },
    },
    404: {
      description: 'The run does not exist, or another user or billing owner minted it (`errorCode: "run_not_found"`).',
      schema: RunNotFoundErrorSchema,
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
