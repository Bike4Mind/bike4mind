import type { z } from 'zod';
import type { ApiKeyScope } from '../types/entities/UserApiKeyTypes';

/**
 * Transport-agnostic API endpoint contract.
 *
 * A contract is PURE DATA - it declares an endpoint's method, path, auth,
 * scopes, request/response schemas, and doc metadata, and nothing else. It has
 * zero coupling to any transport (Next.js `req/res`, AWS Lambda Function URLs)
 * and MUST NOT call `.openapi()` (that method only exists after
 * `extendZodWithOpenApi` runs, which the runtime handlers never do - calling it
 * here would crash the endpoint at import; see openapi/registry.ts).
 *
 * One contract is consumed by three independent derivations:
 *   1. the OpenAPI registrar (openapi/registerContract.ts) -> the spec + docs,
 *   2. the Next.js route adapter (server/middlewares/defineNextRoute.ts),
 *   3. the Lambda route adapter (server/cli/defineLambdaRoute.ts).
 * Define once; derive everything. Nothing can drift because there is one source.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Which credential the endpoint accepts. Maps to the OpenAPI security scheme
 * AND tells the adapters which auth to run.
 * - `apiKeyOrJwt`: a `b4m_live_` key (scope-gated) or a JWT access token.
 * - `jwtOnly`: JWT only, API keys rejected (e.g. the tools endpoint).
 * - `public`: no auth.
 */
export type AuthMode = 'apiKeyOrJwt' | 'jwtOnly' | 'public';

export type ResponseSpec = {
  description: string;
  schema: z.ZodTypeAny;
  /**
   * Response media type, default `application/json`. Set to `text/event-stream`
   * for an SSE endpoint so the generated spec advertises the stream shape rather
   * than a JSON body (the schema then documents a single stream event).
   */
  contentType?: string;
  /** Example response body, attached to the generated component. */
  example?: unknown;
};

/** curl/JS/Python sample body for the docs (attached as x-codeSamples). */
export type CodeSample = {
  body: unknown;
  authToken: string;
  streaming?: boolean;
};

export type EndpointContract<ReqSchema extends z.ZodTypeAny = z.ZodTypeAny> = {
  method: HttpMethod;
  path: string;
  /** Stable camelCase id; becomes the SDK method name. Treat as a public contract. */
  operationId: string;
  summary: string;
  description?: string;
  tags?: string[];
  auth: AuthMode;
  /** OR-semantics: an API key needs ANY ONE of these. Only meaningful for apiKey auth. */
  scopes?: readonly ApiKeyScope[];
  /** The schema the handlers validate the request body with (all transports). */
  request?: ReqSchema;
  /**
   * Optional OpenAPI-representable projection of `request`, used ONLY for the
   * generated spec. Needed when `request` carries wrappers zod-to-openapi cannot
   * introspect (`.catch()`, `.transform()`, `.pipe()`). Its INPUT shape must
   * match `request` exactly, so it is a doc projection, not a second contract.
   * Defaults to `request` when omitted.
   */
  requestDoc?: z.ZodTypeAny;
  requestExample?: unknown;
  responses: Record<number, ResponseSpec>;
  /** SSE endpoint: skips JSON response-body docs and gets streaming code samples. */
  streaming?: boolean;
  codeSample?: CodeSample;
};
