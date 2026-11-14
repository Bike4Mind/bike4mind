import { defineEndpoint } from '../defineEndpoint';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
// Specific files, not the barrel (`../../schemas`) - see the note in tools.contract.ts.
import {
  WeatherToolRequestSchema,
  WebFetchToolRequestSchema,
  WebSearchToolRequestSchema,
  WebToolResultResponseSchema,
} from '../../schemas/webTools';
import { ApiErrorSchema, InsufficientCreditsErrorSchema, ScopeForbiddenErrorSchema } from '../../schemas/chat';

/**
 * POST /api/v1/tools/{web-search,web-fetch,weather} - one built-in tool per call, for integrators
 * running their own agent loop.
 *
 * New /api/v1 routes rather than contracts wrapped around the SPA-internal /api/tools/* doors (which
 * the voice modal and the desktop app call): LEGACY_PUBLIC_PATHS is frozen. Both doors share their
 * implementation (apps/client/server/tools/webToolRoutes.ts), their scope gate, the outbound-action
 * gate and one hourly budget (toolRoutesRateLimit), so they cannot drift apart. The JWT-only
 * POST /api/ai/v1/tools (tools.contract.ts) is a separate surface serving the CLI.
 */
const SCOPES = [ApiKeyScope.AI_CHAT, ApiKeyScope.AI_GENERATE];

const AUTH =
  'Authenticate with an API key (`b4m_live_`) carrying `ai:chat` or `ai:generate`, or a JWT. Every call ' +
  'counts against one hourly budget of 600 calls per user, shared by the three `/api/v1/tools/*` endpoints.';

const BILLED =
  "Billed per call from the caller's credits (or their organization's) when the deployment's provider " +
  'charges for it, and refused with a 422 `insufficient_credits` before the provider is called when the ' +
  'payer cannot cover it.';

const FORBIDDEN = {
  description:
    'The API key holds neither `ai:chat` nor `ai:generate`, or the account may not use outbound tools right ' +
    'now (an administrator restricted it, or it is new or unverified: `errorCode: "account_trust_required"`).',
  schema: ScopeForbiddenErrorSchema,
};

const RATE_LIMITED = {
  description: 'Rate limit exceeded: the per-key limit, or the hourly budget shared by the tool endpoints.',
  schema: ApiErrorSchema,
};

const BILLING_UNRESOLVED = {
  description:
    'The billing user or organization could not be resolved, or the API key bills an organization its owner ' +
    'is no longer a member of.',
  schema: ApiErrorSchema,
};

const INSUFFICIENT_CREDITS = {
  description:
    'Request body failed validation, or the caller cannot afford the call (`errorCode: "insufficient_credits"`).',
  schema: InsufficientCreditsErrorSchema,
};

const SEARCH_EXAMPLE = { query: 'latest stable TypeScript release', num_results: 3 };

export const searchWebContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/tools/web-search',
  operationId: 'searchWeb',
  summary: 'Search the web',
  description:
    'Runs one web search on the provider this deployment is configured with and returns the hits as one ' +
    'formatted text block (title, link and snippet per result), ready to hand to a model. When no search ' +
    'provider is configured, `result` says so instead of listing hits. ' +
    BILLED +
    ' ' +
    AUTH,
  tags: ['Tools'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  request: WebSearchToolRequestSchema,
  requestExample: SEARCH_EXAMPLE,
  responses: {
    200: {
      description: 'The formatted search results.',
      schema: WebToolResultResponseSchema,
      example: { result: '1. TypeScript release notes\n   https://example.com/release-notes\n   ...' },
    },
    400: BILLING_UNRESOLVED,
    401: { description: 'Missing or invalid credentials.', schema: ApiErrorSchema },
    403: FORBIDDEN,
    422: INSUFFICIENT_CREDITS,
    429: RATE_LIMITED,
    500: { description: 'The search provider failed, or an unexpected server error.', schema: ApiErrorSchema },
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: SEARCH_EXAMPLE },
});

const FETCH_EXAMPLE = { url: 'https://example.com/docs/getting-started' };

export const fetchWebPageContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/tools/web-fetch',
  operationId: 'fetchWebPage',
  summary: 'Read a web page',
  description:
    'Fetches one public http or https page and returns its readable content as Markdown, headed by the page ' +
    'title when it has one. A long page is truncated, and the end of `result` says which `offset` to pass ' +
    'to read the next part. Private, loopback and cloud-metadata addresses are refused. ' +
    BILLED +
    ' ' +
    AUTH,
  tags: ['Tools'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  request: WebFetchToolRequestSchema,
  requestExample: FETCH_EXAMPLE,
  responses: {
    200: {
      description: 'The page content as Markdown.',
      schema: WebToolResultResponseSchema,
      example: { result: '# Getting started\n\nInstall the package, then ...' },
    },
    400: {
      description:
        'The URL points at an address that may not be fetched (private, loopback or cloud metadata), the ' +
        'billing user or organization could not be resolved, or the API key bills an organization its owner ' +
        'is no longer a member of.',
      schema: ApiErrorSchema,
    },
    401: { description: 'Missing or invalid credentials.', schema: ApiErrorSchema },
    403: FORBIDDEN,
    422: {
      description:
        'Request body failed validation, the page cannot be read (unreachable, or a content type that is not ' +
        'a readable page), or the caller cannot afford the call (`errorCode: "insufficient_credits"`).',
      schema: InsufficientCreditsErrorSchema,
    },
    429: RATE_LIMITED,
    500: { description: 'The fetch failed, or an unexpected server error.', schema: ApiErrorSchema },
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: FETCH_EXAMPLE },
});

const WEATHER_EXAMPLE = { lat: 47.6062, lon: -122.3321, units: 'metric' as const };

export const getCurrentWeatherContract = defineEndpoint({
  method: 'post',
  path: '/api/v1/tools/weather',
  operationId: 'getCurrentWeather',
  summary: 'Get the current weather',
  description: 'Returns the current temperature and conditions at a coordinate as one sentence. Not billed. ' + AUTH,
  tags: ['Tools'],
  auth: 'apiKeyOrJwt',
  scopes: SCOPES,
  request: WeatherToolRequestSchema,
  requestExample: WEATHER_EXAMPLE,
  responses: {
    200: {
      description: 'The current weather as one sentence.',
      schema: WebToolResultResponseSchema,
      example: { result: "Right now it's 14\u00b0 in Seattle, with light rain." },
    },
    401: { description: 'Missing or invalid credentials.', schema: ApiErrorSchema },
    403: FORBIDDEN,
    429: RATE_LIMITED,
    500: {
      description: 'The weather provider is not configured or failed, or an unexpected server error.',
      schema: ApiErrorSchema,
    },
  },
  emitsRateLimitHeaders: true,
  codeSample: { authToken: 'b4m_live_<key>', streaming: false, body: WEATHER_EXAMPLE },
});
