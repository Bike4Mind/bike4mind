import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { CompletionRunSchema, CreateCompletionRunRequestSchema } from '../../schemas/cliCompletions';

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
  },
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { rootSessionId: 'session-42' },
  },
});
