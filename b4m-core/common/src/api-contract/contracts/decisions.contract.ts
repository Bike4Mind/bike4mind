import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  DecisionResponseSchema,
  DecisionsErrorSchema,
  DecisionsRequestSchema,
  ListDecisionModelsResponseSchema,
} from '../../schemas/decisions';
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';
import { DECISION_PLATFORM_LIMITS } from '../../decisions/catalog';

const DECISION_SCOPES = [ApiKeyScope.AI_DECIDE, ApiKeyScope.AI_GENERATE];

const scopeForbidden = {
  description: 'The API key holds neither `ai:decide` nor `ai:generate`.',
  schema: ScopeForbiddenErrorSchema,
};
const rateLimited = { description: 'Per-key or per-user decisions rate limit exceeded.', schema: ApiErrorSchema };

const EXAMPLE_REQUEST = {
  model: 'gpt-6-luna',
  input: [
    { type: 'text', text: 'Help! My payouts have been failing for 3 days.' },
    { type: 'json', json: { plan: 'pro', open_tickets: 2 } },
  ],
  questions: [
    { type: 'predicate', name: 'is_urgent', instructions: 'The customer needs a reply within 24 hours.' },
    {
      type: 'choice',
      name: 'team',
      instructions: 'Which team should handle this?',
      choices: [
        { value: 'billing', description: 'Payments, payouts, refunds' },
        { value: 'technical', description: 'Bugs, outages' },
        { value: 'sales' },
      ],
    },
    {
      type: 'score',
      name: 'frustration',
      instructions: 'How frustrated is the customer?',
      levels: [{ label: 'calm' }, { label: 'frustrated' }, { label: 'angry', description: 'Threatens to churn' }],
    },
  ],
};

/**
 * Contract for POST /api/v1/decisions - typed questions about an input, answered with calibrated probabilities.
 *
 * Provider-neutral: one shape fronts every vendor decision model, so a caller switches providers by changing
 * `model`. Synchronous because a call takes tens of milliseconds and its output is bounded by the question list.
 */
export const createDecisionContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/decisions',
  operationId: 'createDecision',
  summary: 'Answer typed questions with probabilities',
  description:
    'Evaluates each question independently against the same `input` and returns calibrated probabilities - ' +
    'no generated text. Question types: `predicate` (probability a statement is true), `choice` (pick one ' +
    'value) and `score` (an ordered scale; `score` is the probability-weighted mean of 0-based level ' +
    'indices). `confidence` is computed by B4M with one published formula for every model. Answers come back ' +
    'in question order; a question the model declines is a `refusal` answer and does not fail the request. ' +
    '`input` is a string or a list of `text`, `json` and `image` parts; an image is a `file_id` you can read ' +
    'or a base64 `data:` URL (http(s) URLs are rejected). Platform ceilings: ' +
    `${DECISION_PLATFORM_LIMITS.maxQuestions} questions, ${DECISION_PLATFORM_LIMITS.maxChoices} choices, ` +
    `${DECISION_PLATFORM_LIMITS.minLevels}-${DECISION_PLATFORM_LIMITS.maxLevels} levels and ` +
    `${DECISION_PLATFORM_LIMITS.maxImages} images; each model's own caps are listed by ` +
    '`GET /api/v1/decision-models` and a request over one is a 422 naming the cap and `param`. ' +
    'Probabilities are not comparable across models: tune thresholds per model against labelled examples, ' +
    'and pin a versioned model id when you do. A busy provider is retried once on the same model, never ' +
    'another; after that the response is a 503 with `Retry-After`. Billed per input and output token at the ' +
    "model's rate, settled to the exact expected cost (most calls charge 0 credits, some 1). Authenticate " +
    'with an API key (`b4m_live_`) carrying `ai:decide` or `ai:generate`, or a JWT.',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: DECISION_SCOPES,
  request: DecisionsRequestSchema,
  requestExample: EXAMPLE_REQUEST,
  responses: {
    200: {
      description: 'One answer per question, in question order.',
      schema: DecisionResponseSchema,
      example: {
        id: 'dec_8f14e45fceea167a5a36dedd4bea2543',
        object: 'decision',
        model: 'gpt-6-luna',
        answers: [
          { type: 'predicate', name: 'is_urgent', probability: 0.93 },
          {
            type: 'choice',
            name: 'team',
            choice: 'billing',
            probabilities: [
              { value: 'billing', probability: 0.88 },
              { value: 'technical', probability: 0.1 },
              { value: 'sales', probability: 0.02 },
            ],
            confidence: 0.82,
          },
          {
            type: 'score',
            name: 'frustration',
            score: 1.1,
            probabilities: [
              { value: 0, label: 'calm', probability: 0.1 },
              { value: 1, label: 'frustrated', probability: 0.7 },
              { value: 2, label: 'angry', probability: 0.2 },
            ],
            confidence: 0.55,
          },
        ],
        usage: { input_tokens: 412, output_tokens: 0, total_tokens: 412 },
      },
    },
    400: {
      description:
        'The billing user or organization could not be resolved, or the API key bills an organization ' +
        'its owner is no longer a member of.',
      schema: ApiErrorSchema,
    },
    401: {
      description:
        'Missing/invalid credentials, or the provider refused the configured key (`errorCode: "provider_rejected"`).',
      schema: DecisionsErrorSchema,
    },
    403: scopeForbidden,
    404: {
      description:
        'An image `file_id` does not exist or is not readable by the caller. Reading one also needs the ' +
        '`files:read` scope; a key without it gets 403.',
      schema: DecisionsErrorSchema,
    },
    422: {
      description:
        'The body failed validation, or the request exceeds a per-model cap (`limit_exceeded`), sends an ' +
        'image to a text-only model (`unsupported_input`), repeats a question name or choice value ' +
        '(`invalid_request`), names a model this deployment does not serve (`model_unavailable`), overflows ' +
        'the model context (`context_length_exceeded`), or the caller cannot afford it (`insufficient_credits`). ' +
        '`param` names the offending field when there is one.',
      schema: DecisionsErrorSchema,
    },
    429: rateLimited,
    502: {
      description: 'The provider failed or answered something that does not fit the questions (`provider_error`).',
      schema: DecisionsErrorSchema,
    },
    503: {
      description:
        'The provider stayed overloaded through one same-model retry (`errorCode: "provider_overloaded"`), or ' +
        'this deployment has no credential for the model (`errorCode: "provider_not_configured"`).',
      schema: DecisionsErrorSchema,
      headers: { 'Retry-After': 'Seconds to wait before retrying; sent with `provider_overloaded`.' },
    },
  },
  // Served by baseApi, so apiKeyRateLimit sets the windowed X-RateLimit-* headers.
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: EXAMPLE_REQUEST },
});

export const listDecisionModelsContract = defineEndpoint({
  method: 'get',
  path: '/api/v1/decision-models',
  operationId: 'listDecisionModels',
  summary: 'List the decision models you can use',
  description:
    'Returns the decision models this deployment serves, with their per-model caps and USD token prices. ' +
    'A floating alias carries `alias_of`; pin the versioned id when you tune thresholds, since a new version ' +
    'can shift probabilities. The catalog is a handful of entries, so it is returned whole, not paginated ' +
    '(as `GET /api/v1/video-models`).',
  tags: ['AI'],
  auth: 'apiKeyOrJwt',
  scopes: DECISION_SCOPES,
  responses: {
    200: { description: 'The served models.', schema: ListDecisionModelsResponseSchema },
    403: scopeForbidden,
    429: rateLimited,
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: {} },
});
