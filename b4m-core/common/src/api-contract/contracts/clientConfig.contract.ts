import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import { ApiErrorSchema } from '../../schemas/chat';
import { ClientConfigResponseSchema } from '../../schemas/clientConfig';

/**
 * Contract for GET /api/v1/client-config: one call that tells an API client how to configure
 * itself - deployment status, which features are switched on, upload and credit limits, and the
 * models it may call.
 *
 * Before this, that picture was assembled from several unversioned internal routes
 * (`/api/settings/*`, `/api/models`) that return internal shapes. Those keep serving the SPA
 * unchanged; this is purely additive. Identity, plan and entitlements stay on `GET /api/v1/me`.
 */
export const getClientConfigContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/client-config',
  operationId: 'getClientConfig',
  summary: 'Get client configuration',
  description:
    'Returns what a client needs to configure itself in one call: whether the deployment is live, ' +
    'which product features are switched on deployment-wide, upload and credit limits, the default and ' +
    'recommended model ids, and every model the caller can use right now (the same list ' +
    '`GET /api/v1/models` pages through, unpaginated here). A feature flag says whether the deployment ' +
    "offers the feature, not whether this caller has opted in. The caller's identity, plan and " +
    'entitlements are not repeated here - read them from `GET /api/v1/me`. Responses are never cacheable. ' +
    'Authenticate with an API key (`b4m_live_`) carrying `me:read`, `ai:chat` or `ai:generate`, or a JWT.',
  tags: ['Account'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.ME_READ, ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE],
  emitsRateLimitHeaders: true,
  responses: {
    200: {
      description: 'The deployment status, feature switches, limits, and the models available to the caller.',
      schema: ClientConfigResponseSchema,
      example: {
        server: { status: 'live', app_url: 'https://app.example.com', support_email: 'support@example.com' },
        features: {
          agents: true,
          agent_mode: true,
          artifacts: true,
          data_lakes: false,
          deep_research: true,
          knowledge_base_search: true,
          mcp_server: false,
          custom_mcp_connectors: false,
          mementos: false,
          quest_master: true,
          rapid_reply: true,
          research_engine: true,
          team_plan: false,
          voice_sessions: false,
        },
        limits: { max_upload_size_mb: 30, credits_enforced: true, low_credits_threshold: 1000 },
        models: {
          default_id: 'claude-sonnet-5',
          recommended_ids: ['claude-sonnet-5'],
          available: [
            {
              id: 'claude-sonnet-5',
              name: 'Claude Sonnet 5',
              type: 'text',
              backend: 'anthropic',
              description: null,
              context_window: 1_000_000,
              max_output_tokens: 128_000,
              supports_streaming: true,
              supports_thinking: true,
              reasons_within_output_budget: true,
              reasoning_efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
              supports_tools: true,
              supports_tool_search: true,
              supports_tool_changes: false,
              supports_assistant_prefill: false,
              supports_vision: true,
              deprecation_date: null,
              replaced_by: null,
              image: null,
              credits_per_1m_tokens: { input: 4000, output: 20000, cached_input: 400 },
            },
          ],
        },
      },
    },
    429: { description: 'Per-user rate limit exceeded.', schema: ApiErrorSchema },
  },
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
