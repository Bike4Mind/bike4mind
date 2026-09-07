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
  /**
   * Shape of the response body. OMIT for a raw, non-JSON body (e.g. the audio
   * bytes the TTS/music/sound-effects endpoints stream back): the spec then
   * documents `contentType` as an opaque binary payload, and the adapters' dev
   * response drift check skips the status because there is no JSON to check.
   */
  schema?: z.ZodTypeAny;
  /**
   * Response media type, default `application/json`. Set to `text/event-stream`
   * for an SSE endpoint so the generated spec advertises the stream shape rather
   * than a JSON body (the schema then documents a single stream event), or to an
   * `audio/*` type alongside an omitted `schema` for raw bytes.
   */
  contentType?: string;
  /** Example response body, attached to the generated component. */
  example?: unknown;
  /**
   * Extra media types this status can also return, for an endpoint whose response
   * encoding is caller-selected - currently only TTS, which returns raw audio
   * bytes by default and JSON when the caller asks for `encoding: 'base64'`.
   * `schema`/`contentType` above stay the primary body: they are what the
   * adapters' dev drift check validates JSON responses against, so put the JSON
   * shape there and list the raw-byte media types here.
   */
  alsoReturns?: readonly { contentType: string; schema?: z.ZodTypeAny; example?: unknown }[];
  /**
   * Response headers to publish, keyed by header name. All are documented as
   * strings (HTTP headers have no other wire type). Worth declaring when a header
   * carries information the body does not - e.g. the endpoints that return raw
   * audio bytes report where the saved copy lives only in a header.
   * `X-Request-ID` is attached to every response centrally; do not repeat it.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Documented exemption from the shared `ApiErrorSchema` envelope for a >= 400
   * response, carrying the REASON it cannot conform. Deliberately a string, not a
   * boolean: the exemptions must be greppable and justified in place, since every
   * one of them is a shape a generated client has to special-case.
   * Enforced by assertContractConventions.ts; see CONVENTIONS.md section 1.
   */
  bespokeErrorShape?: string;
};

/** curl/JS/Python sample body for the docs (attached as x-codeSamples). */
export type CodeSample = {
  body: unknown;
  authToken: string;
  streaming?: boolean;
};

/**
 * A rule in CONVENTIONS.md that `assertContractConventions` enforces, and that a
 * contract can be exempted from. Exemptions exist because this gate was added to
 * an ALREADY-PUBLISHED surface: some conforming change would break live callers,
 * which the conventions themselves forbid.
 *
 * `error-envelope` is deliberately absent: `ResponseSpec.bespokeErrorShape`
 * already excuses that rule per-RESPONSE, so a contract-wide version would only
 * ever be the blunter way to say the same thing.
 */
export type ConventionRule = 'status-table' | 'scope-required' | 'version-root';

/**
 * Exemptions from {@link ConventionRule}, each carrying WHY.
 *
 * `status-table` is keyed by the individual status it excuses, not granted
 * contract-wide: tolerating one off-table status must not also wave through an
 * unrelated `418` on the same endpoint. The other two rules are contract-wide
 * because that is genuinely their scope - a path has one shape, and an endpoint
 * either gates on a scope or does not.
 *
 * NO contract carries an exemption today (`assertContractConventions.test.ts` pins
 * that). The type stays because the next rule added to an already-published
 * surface will need it - but an empty set is the steady state, so adding an entry
 * means arguing for it, not following precedent.
 */
export type ConventionExemptions = {
  /** HTTP status -> why this endpoint may keep returning it. */
  'status-table'?: Readonly<Record<number, string>>;
  'scope-required'?: string;
  'version-root'?: string;
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
   * Schema for dynamic path segments (e.g. `{id}` in `/api/sessions/{id}`).
   * Values arrive via Next.js's file-based routing convention as `req.query`
   * (Next merges route params into `query`, it does not populate `req.params`),
   * so the adapter validates `req.query` against this schema, not `req.params`.
   * Field names must match the `{name}` placeholders in `path`. Must be a plain
   * ZodObject - that is what zod-to-openapi's `request.params` accepts.
   *
   * Next-only today: `defineNextRoute.ts`'s adapter is the only one that reads this
   * field. The Lambda adapter (`server/cli/defineLambdaRoute.ts`) does not validate
   * path params yet - a `{id}`-style contract served over a Function URL gets no
   * param validation there until that adapter is taught to read `pathParams` too.
   */
  pathParams?: z.ZodObject<z.ZodRawShape>;
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
  /**
   * This endpoint's responses carry the six `X-RateLimit-*-{Minute,Day}` headers,
   * i.e. it runs the `apiKeyRateLimit` middleware (via `baseApi`). Declared here
   * rather than inferred, because whether a route reaches that middleware is a
   * transport fact the contract cannot derive: the Lambda adapter sets no such
   * headers, and the Fargate SSE route computes them but discards them.
   * Must stay in sync with the middleware chain the handler actually mounts.
   */
  emitsRateLimitHeaders?: boolean;
  codeSample?: CodeSample;
  /**
   * Conventions this endpoint is exempt from, each mapped to WHY. The only
   * legitimate reason: the endpoint was published before the rule existed and
   * conforming now would break live callers - a status code and a required scope
   * cannot be aliased the way a URL or a field can. A record rather than a list
   * so the justification lives next to the exemption and stays greppable.
   * This is debt: entries are meant to be removed behind a sunset, never added
   * for a new endpoint. See CONVENTIONS.md.
   */
  conventionExemptions?: Readonly<ConventionExemptions>;
};
