import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { EXAMPLE_SESSION_ID } from '../exampleIds';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  ApiErrorSchema,
  InsufficientCreditsErrorSchema,
  ProviderNotConfiguredErrorSchema,
  ScopeForbiddenErrorSchema,
} from '../../schemas/chat';
import {
  CreateVoiceSessionRequestSchema,
  CreateVoiceSessionResponseSchema,
  EndVoiceSessionResponseSchema,
  ListVoicesResponseSchema,
  VoiceSessionIdParamSchema,
} from '../../schemas/voiceApi';

/**
 * Contracts for the real-time voice endpoints. Each one is also served at its frozen
 * `/api/voice/v2/*` path (CONVENTIONS.md section 3), which the SPA still calls, so the
 * wire shapes here are shared with it. `/api/voice/v2/llm-proxy` is NOT public: ElevenLabs
 * calls it with the signed `sessionToken`, never an API key.
 *
 * Gated on `ai:generate`, like the audio-generation contracts: opening a call reserves credits.
 */

const FEATURE_DISABLED = 'Voice is not enabled on this deployment (`voiceV2Enabled` is off)';
const PROVIDER_NOT_CONFIGURED = {
  description: 'This deployment has no ElevenLabs server API key configured (`errorCode: "provider_not_configured"`).',
  schema: ProviderNotConfiguredErrorSchema,
} as const;

export const listVoicesContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/voice/voices',
  operationId: 'listVoices',
  summary: 'List voices',
  description:
    'Lists the voices available in the configured ElevenLabs workspace. The list is not paged: it is the ' +
    'whole workspace catalog, cached in memory per server instance for up to 15 minutes. ' +
    '`GET /api/voice/v2/voices` is a legacy ' +
    'alias of this endpoint. Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['Voice'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  responses: {
    200: {
      description: 'The workspace voices.',
      schema: ListVoicesResponseSchema,
      example: {
        voices: [
          {
            id: '21m00Tcm4TlvDq8ikWAM',
            name: 'Rachel',
            labels: { accent: 'american', gender: 'female' },
            previewUrl: 'https://storage.googleapis.com/eleven-public-prod/premade/voices/rachel.mp3',
          },
        ],
      },
    },
    403: {
      description: `The API key does not hold \`ai:generate\`, or ${FEATURE_DISABLED}.`,
      schema: ScopeForbiddenErrorSchema,
    },
    502: { description: 'ElevenLabs failed to return the voice list.', schema: ApiErrorSchema },
    503: PROVIDER_NOT_CONFIGURED,
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: {},
  },
});

export const createVoiceSessionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/voice/sessions',
  operationId: 'createVoiceSession',
  summary: 'Start a voice session',
  description:
    'Opens a real-time voice conversation on the platform default voice agent, attached to an existing ' +
    'session (`sessionId`) or a new one, and returns the `clientBootstrap` to hand to the ElevenLabs ' +
    'Conversational AI SDK client-side (`Conversation.startSession`): connect with `signedUrl`, apply ' +
    'any overrides, and forward `sessionToken` as `custom_llm_extra_body.b4m_session`. Transcripts are ' +
    'appended to the session as the call runs. When credits are enforced, the maximum call length is ' +
    'reserved up front and reconciled down by `POST /api/v1/voice/sessions/{id}/end`, so always end the ' +
    'call. Pass `isReconnect: true` to re-attach a dropped transport without a second reservation. ' +
    '`POST /api/voice/v2/sessions` is a legacy alias of this endpoint. Authenticate with an API key ' +
    '(`b4m_live_`) or a JWT.',
  tags: ['Voice'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  request: CreateVoiceSessionRequestSchema,
  requestExample: { sessionId: EXAMPLE_SESSION_ID },
  responses: {
    200: {
      description:
        'The call is provisioned. `clientBootstrap` is consumed by the ElevenLabs Conversational AI SDK ' +
        'in the client; `signedUrl` is short-lived, so connect promptly.',
      schema: CreateVoiceSessionResponseSchema,
      example: {
        session: { id: EXAMPLE_SESSION_ID, name: 'Voice \u2022 claude-sonnet-4-6' },
        reasoningModelId: 'claude-sonnet-4-6',
        clientBootstrap: {
          transport: 'elevenlabs-conversational',
          signedUrl: 'wss://api.elevenlabs.io/v1/convai/conversation?agent_id=agent_123&conversation_signature=sig',
          agentId: 'agent_123',
          sessionToken: 'eyJhbGciOiJIUzI1NiJ9.<payload>.<signature>',
        },
      },
    },
    400: {
      description: 'No default voice agent is configured for this deployment.',
      schema: ApiErrorSchema,
    },
    403: {
      description:
        `The API key does not hold \`ai:generate\`, ${FEATURE_DISABLED}, or the caller already has the ` +
        'maximum number of concurrent voice sessions open (end one first).',
      schema: ScopeForbiddenErrorSchema,
    },
    404: {
      description: 'The `sessionId` does not exist or is not owned by the caller (a malformed id is also a 404).',
      schema: ApiErrorSchema,
    },
    422: {
      description:
        'Request body failed validation, or the caller cannot afford the up-front reservation - the latter ' +
        'is tagged `errorCode: "insufficient_credits"`.',
      schema: InsufficientCreditsErrorSchema,
    },
    502: {
      description: 'ElevenLabs failed to provision the conversation; any reserved credits are refunded.',
      schema: ApiErrorSchema,
    },
    503: PROVIDER_NOT_CONFIGURED,
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
    body: { sessionId: EXAMPLE_SESSION_ID },
  },
});

export const endVoiceSessionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/voice/sessions/{id}/end',
  operationId: 'endVoiceSession',
  summary: 'End a voice session',
  description:
    'Reconciles the credit reservation taken by `POST /api/v1/voice/sessions` down to the actual call ' +
    'duration and refunds the difference. Call it when the conversation ends. Idempotent: once the hold ' +
    'is cleared, a repeat call refunds nothing and reports `alreadyReconciled: true`. Only the session ' +
    'owner can end a call. `POST /api/voice/v2/sessions/{id}/end` is a legacy alias of this endpoint. ' +
    'Authenticate with an API key (`b4m_live_`) or a JWT.',
  tags: ['Voice'],
  auth: 'apiKeyOrJwt',
  scopes: [ApiKeyScope.AI_GENERATE],
  pathParams: VoiceSessionIdParamSchema,
  responses: {
    200: {
      description: 'The reservation is reconciled.',
      schema: EndVoiceSessionResponseSchema,
      example: { refunded: 42, elapsedSeconds: 95 },
    },
    404: {
      description: 'No session with that id is owned by the caller (a malformed id is also a 404).',
      schema: ApiErrorSchema,
    },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: {
    authToken: 'b4m_live_<key>',
    streaming: false,
  },
});
