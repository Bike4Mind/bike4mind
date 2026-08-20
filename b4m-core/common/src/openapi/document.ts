import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';
import { ALL_API_KEY_SCOPES, REQUIRED_SCOPES } from './security';

// Importing these modules is what registers their schemas/paths against the
// shared registry (side-effect imports). Keep them before generateDocument().
// `registeredContracts` is the same import: it reports what ./operations put in
// the registry, which is the only honest source for per-operation metadata.
import './schemas';
import { registeredContracts } from './operations';

// Neutral placeholder default so the committed openapi.json never hardcodes a
// real deployment domain in this public repo (matches apiReferenceContent.ts).
// Real deployments set B4M_OPENAPI_PROD_URL at build time.
const PLACEHOLDER_PROD_URL = 'https://your-deployment.example.com';

/** The production base URL - single source for both servers() and codeSamples(). */
function prodUrl(): string {
  return process.env.B4M_OPENAPI_PROD_URL ?? PLACEHOLDER_PROD_URL;
}

/**
 * Server URLs are env-overridable with neutral placeholder defaults so the
 * committed openapi.json never hardcodes a real deployment domain in this public
 * repo (matches the placeholder convention in apiReferenceContent.ts). Real
 * deployments set these at build time.
 */
function servers() {
  return [
    { url: prodUrl(), description: 'Production' },
    {
      url: process.env.B4M_OPENAPI_STAGING_URL ?? 'https://staging.your-deployment.example.com',
      description: 'Staging',
    },
    { url: process.env.B4M_OPENAPI_LOCAL_URL ?? 'http://localhost:3000', description: 'Local dev' },
  ];
}

function infoDescription(): string {
  return [
    'Programmatic access to the Bike4Mind API. Schemas are generated from the same Zod definitions ' +
      'that validate requests at runtime, so this spec cannot drift from the implementation.',
    '',
    '## Authentication',
    'Send an API key as `Authorization: Bearer b4m_live_<key>` (canonical), `x-api-key: b4m_live_<key>` ' +
      '(legacy), or `Authorization: ApiKey b4m_live_<key>`. A JWT access token is also accepted in the ' +
      '`Authorization: Bearer` header.',
    '',
    '## Scopes',
    'API keys carry `resource:action` scopes. The canonical set (from the runtime `ApiKeyScope` enum) is:',
    ...ALL_API_KEY_SCOPES.map(s => `- \`${s}\``),
    '',
    'Per-operation required scopes are published via the `x-required-scopes` extension. Semantics are OR: ' +
      "a key needs ANY ONE of an operation's listed scopes, not all of them. Operations with no " +
      '`x-required-scopes` enforce no scope (e.g. the JWT-only tools endpoint).',
    '',
    '## CORS',
    'The spec (`/api/v1/openapi.json`) is served publicly with permissive CORS. The API endpoints ' +
      'themselves are called server-to-server with a secret key and are not intended for browser CORS use.',
    '',
    '## Correlation',
    'Every response carries an `X-Request-ID` header (echoed as `request_id`/`requestId` in bodies and ' +
      'events) for log correlation.',
  ].join('\n');
}

/**
 * Render a JS value as a pretty Python literal (dict/list/str/True/False/None).
 * Built by walking the value rather than regex-rewriting serialized JSON, so a
 * string value that happens to contain `true`/`false`/`null` is never mangled.
 */
export function toPythonLiteral(value: unknown, indent = 1): string {
  const pad = '    '.repeat(indent + 1);
  const closePad = '    '.repeat(indent);
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map(v => `${pad}${toPythonLiteral(v, indent + 1)}`).join(',\n');
    return `[\n${items}\n${closePad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const items = entries.map(([k, v]) => `${pad}${JSON.stringify(k)}: ${toPythonLiteral(v, indent + 1)}`).join(',\n');
    return `{\n${items}\n${closePad}}`;
  }
  return 'None';
}

/**
 * curl / JS / Python samples, attached to each operation as `x-codeSamples`.
 * `streaming` toggles the SSE-only affordances (curl `-N`, Python `stream=True`)
 * so the non-streaming tools endpoint does not tell users to stream JSON.
 * The curl body is piped through a quoted heredoc (`--data-binary @-`) so a
 * single quote inside the JSON body can never break out of the shell string.
 * The delimiter is deliberately unusual so it cannot collide with a body line
 * (a bare `JSON` line in a future dynamic body would end the heredoc early).
 */
const CURL_HEREDOC_DELIMITER = 'B4M_REQUEST_BODY';

function codeSamples(path: string, body: unknown, streaming: boolean, authToken: string, method: string) {
  // A raw OpenAPI path template (`/api/sessions/{id}`) is not a runnable URL - swap each
  // `{param}` for a `<param>` placeholder, matching this file's existing `<key>`/`<fabFileId>`
  // convention for "substitute your own value here", so a copy-pasted sample doesn't 404.
  const url = `${prodUrl()}${path.replace(/\{(\w+)\}/g, '<$1>')}`;
  const pretty = JSON.stringify(body, null, 2);
  const curlFlags = streaming ? '-sN' : '-s';
  const pyStream = streaming ? '\n    stream=True,' : '';
  const d = CURL_HEREDOC_DELIMITER;
  // `requests` exposes one function per verb (requests.get/post/put/patch/delete/...),
  // matching the lowercase HTTP method name exactly.
  const pyMethod = method.toLowerCase();
  return [
    {
      lang: 'curl',
      label: 'curl',
      source:
        `curl ${curlFlags} -X ${method.toUpperCase()} "${url}" \\\n` +
        `  -H "Authorization: Bearer ${authToken}" \\\n` +
        `  -H "Content-Type: application/json" \\\n` +
        `  --data-binary @- <<'${d}'\n${pretty}\n${d}`,
    },
    {
      lang: 'JavaScript',
      label: 'fetch',
      source:
        `const res = await fetch("${url}", {\n` +
        `  method: "${method.toUpperCase()}",\n` +
        `  headers: {\n    "Authorization": "Bearer ${authToken}",\n    "Content-Type": "application/json",\n  },\n` +
        `  body: JSON.stringify(${pretty}),\n});`,
    },
    {
      lang: 'Python',
      label: 'requests',
      source:
        `import requests\n\n` +
        `res = requests.${pyMethod}(\n    "${url}",\n` +
        `    headers={"Authorization": "Bearer ${authToken}"},\n` +
        `    json=${toPythonLiteral(body)},${pyStream}\n)`,
    },
  ];
}

// Legacy hand-registered code samples. Now EMPTY: every operation is a contract
// that carries its own `codeSample`. Kept as an extension point (see REQUIRED_SCOPES).
const CODE_SAMPLES: Record<string, { streaming: boolean; authToken: string; body: unknown }> = {};

type CodeSampleSpec = { streaming: boolean; authToken: string; body: unknown };

/**
 * Per-operationId metadata for the post-generation pass, merging legacy
 * (hand-registered) scopes/samples with contract-derived ones so a contract-based
 * operation publishes x-required-scopes + x-codeSamples with no second declaration.
 *
 * Derived from the contracts actually REGISTERED, not from `CONTRACTS`:
 * `registerContracts` takes an explicit array, so the two can differ and the
 * document must describe what the registry holds. Computed per call for the same
 * reason - the registry is module-global and callers register into it.
 */
function operationMetadata() {
  const contracts = registeredContracts();
  const withCodeSample = contracts.filter(c => c.codeSample);
  return {
    scopes: {
      ...(REQUIRED_SCOPES as Record<string, readonly string[]>),
      ...Object.fromEntries(contracts.filter(c => c.scopes?.length).map(c => [c.operationId, c.scopes as string[]])),
    } as Record<string, readonly string[] | undefined>,
    codeSamples: {
      ...CODE_SAMPLES,
      ...Object.fromEntries(
        withCodeSample.map(c => [
          c.operationId,
          { streaming: c.codeSample!.streaming ?? false, authToken: c.codeSample!.authToken, body: c.codeSample!.body },
        ])
      ),
    } as Record<string, CodeSampleSpec | undefined>,
    rateLimitHeaderOps: new Set(contracts.filter(c => c.emitsRateLimitHeaders).map(c => c.operationId)),
    // Statuses each contract declares ITSELF, as opposed to the 401/403 that
    // registerContract injects - the distinction rate-limit headers turn on below.
    declaredStatuses: new Map(contracts.map(c => [c.operationId, new Set(Object.keys(c.responses))])),
  };
}

const REQUEST_ID_HEADER_SPEC = {
  'X-Request-ID': {
    description: 'Correlation id for this request; safe to log and quote in support requests.',
    schema: { type: 'string' as const },
  },
};

/**
 * The rate-limit headers `apiKeyRateLimit` actually sets - two windows, six
 * headers. These names are load-bearing: a client reading the unwindowed
 * `X-RateLimit-Limit` gets `undefined`. Must stay in sync with
 * apps/client/server/middlewares/apiKeyRateLimit.ts.
 */
const INTEGER_HEADER = { type: 'integer' as const };
const RATE_LIMIT_HEADER_SPEC = {
  'X-RateLimit-Limit-Minute': { description: 'Request quota per minute.', schema: INTEGER_HEADER },
  'X-RateLimit-Remaining-Minute': { description: 'Requests remaining in the current minute.', schema: INTEGER_HEADER },
  'X-RateLimit-Reset-Minute': {
    description: 'Unix epoch (seconds) when the minute window resets.',
    schema: INTEGER_HEADER,
  },
  'X-RateLimit-Limit-Day': { description: 'Request quota per day.', schema: INTEGER_HEADER },
  'X-RateLimit-Remaining-Day': { description: 'Requests remaining in the current day.', schema: INTEGER_HEADER },
  'X-RateLimit-Reset-Day': { description: 'Unix epoch (seconds) when the day window resets.', schema: INTEGER_HEADER },
};

/**
 * The auth failures `registerContract` INJECTS carry no rate-limit headers:
 * `apiKeyAuth` throws on an invalid key (401) or an under-scoped one (403), and
 * `apiKeyRateLimit` is mounted AFTER it, so it never runs.
 *
 * That reasoning covers only the injected pair. A contract declaring its own 401
 * or 403 means something else entirely - `/api/ai/tts` 401s `provider_not_configured`
 * from its handler, long after the middleware set all six headers - so the
 * exclusion keys off "the contract did not declare this status", not off the
 * status alone. 429 is never excluded: the middleware sets the headers before
 * throwing TooManyRequests.
 */
const INJECTED_AUTH_STATUSES = new Set(['401', '403']);

function isInjectedAuthFailure(status: string, declaredStatuses: ReadonlySet<string> | undefined): boolean {
  return INJECTED_AUTH_STATUSES.has(status) && !declaredStatuses?.has(status);
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

/**
 * Build the OpenAPI 3.1 document. `version` is the API version (tie to package
 * semver at the call site). Post-processes the generated doc to attach vendor
 * extensions and response headers that the generator does not model directly.
 */
// Return type is widened to a plain record: the document is only ever serialized
// to JSON, and the precise generator type (openapi3-ts/oas31) is not portably
// nameable in this package's emitted .d.ts (composite build).
export function buildOpenApiDocument(version: string): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  const doc = generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Bike4Mind API',
      version,
      description: infoDescription(),
      contact: { name: 'Bike4Mind', url: 'https://your-deployment.example.com' },
      license: { name: 'Proprietary' },
    },
    servers: servers(),
  });

  doc.tags = [
    { name: 'AI', description: 'Chat, completions, and server-side tool execution.' },
    { name: 'Sessions', description: 'Sessions (called "notebooks" in the product UI) and their attached knowledge.' },
    { name: 'Audio', description: 'Speech, music, and sound-effect generation.' },
  ];

  // Attach per-operation vendor extensions + headers by operationId. Restrict to
  // HTTP verbs: a Path Item can also carry summary/description/parameters/servers.
  const meta = operationMetadata();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAPI doc is loosely typed for vendor extensions
  const paths = (doc.paths ?? {}) as Record<string, any>;
  for (const pathKey of Object.keys(paths)) {
    for (const method of Object.keys(paths[pathKey])) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = paths[pathKey][method];
      const opId = op?.operationId as string | undefined;
      if (!opId) continue;

      const scopes = meta.scopes[opId];
      if (scopes) op['x-required-scopes'] = scopes;
      const sample = meta.codeSamples[opId];
      if (sample) op['x-codeSamples'] = codeSamples(pathKey, sample.body, sample.streaming, sample.authToken, method);

      const emitsRateLimitHeaders = meta.rateLimitHeaderOps.has(opId);
      const declaredStatuses = meta.declaredStatuses.get(opId);
      for (const status of Object.keys(op.responses ?? {})) {
        const response = op.responses[status];
        response.headers = { ...REQUEST_ID_HEADER_SPEC, ...(response.headers ?? {}) };
        if (emitsRateLimitHeaders && !isInjectedAuthFailure(status, declaredStatuses)) {
          response.headers = { ...response.headers, ...RATE_LIMIT_HEADER_SPEC };
        }
      }
    }
  }

  // Widen to a plain record (see the signature note); the concrete OpenAPIObject
  // has no index signature, so an explicit cast is required.
  return doc as unknown as Record<string, unknown>;
}
