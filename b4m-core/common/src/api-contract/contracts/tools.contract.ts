import { defineEndpoint } from '../defineEndpoint';
// Import the specific schema files, NOT the barrel (`../../schemas`): the barrel
// re-exports actions.ts, which imports @bike4mind/hearth, whose dist is absent in
// the CI openapi job (install-only, no build) and crashes generation.
import { ToolExecutionRequestSchema, ToolExecutionResponseSchema } from '../../schemas/tools';
import { ApiErrorSchema } from '../../schemas/chat';

/**
 * Contract for POST /api/ai/v1/tools - server-side tool execution.
 *
 * JWT-only (API keys are rejected): the handler runs `verifyJwtToken` only, so
 * `auth: 'jwtOnly'` and no `scopes`. Served by a Lambda Function URL in prod
 * (server/cli/tools.ts via defineLambdaRoute) and a thin Next route in local dev
 * (pages/api/ai/v1/tools.ts). Rate-limited to 100 requests/hour.
 */
export const executeToolContract = defineEndpoint({
  method: 'post',
  path: '/api/ai/v1/tools',
  operationId: 'executeTool',
  summary: 'Execute a server-side tool',
  description:
    'Runs one of the built-in server-side tools (`weather_info`, `web_search`, `web_fetch`) and ' +
    'returns its result as JSON. Authenticate with a JWT access token only - API keys are NOT ' +
    'accepted on this endpoint. Rate-limited to 100 requests/hour. `request_id` echoes the ' +
    'X-Request-ID response header.',
  tags: ['AI'],
  auth: 'jwtOnly',
  request: ToolExecutionRequestSchema,
  requestExample: { toolName: 'web_search', input: { query: 'how to reset a password' } },
  responses: {
    200: {
      description: 'Tool executed successfully (`success` is always true here).',
      schema: ToolExecutionResponseSchema,
      example: {
        success: true,
        result: { summary: 'Top results for the query.' },
        executionTimeMs: 842,
        request_id: 'abc-123',
      },
    },
    400: { description: 'Missing/invalid `toolName` or `input`.', schema: ApiErrorSchema },
    401: { description: 'Missing or invalid JWT (an API key is rejected here).', schema: ApiErrorSchema },
    429: { description: 'Rate limit exceeded (100 requests/hour).', schema: ApiErrorSchema },
    // The handler returns the full ToolExecutionResponse (`success: false`) on a
    // failed-but-executed tool, not the bare error envelope - match that shape.
    500: {
      description: 'Tool execution failed; body carries `success: false` with `error`.',
      schema: ToolExecutionResponseSchema,
    },
  },
  codeSample: {
    authToken: '<access_token>',
    streaming: false,
    body: { toolName: 'web_search', input: { query: 'how to reset a password' } },
  },
});
