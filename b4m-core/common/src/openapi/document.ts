import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';
import { ALL_API_KEY_SCOPES, REQUIRED_SCOPES } from './security';

// Importing these modules is what registers their schemas/paths against the
// shared registry (side-effect imports). Keep them before generateDocument().
import './schemas';
import './operations';

/**
 * Server URLs are env-overridable with neutral placeholder defaults so the
 * committed openapi.json never hardcodes a real deployment domain in this public
 * repo (matches the placeholder convention in apiReferenceContent.ts). Real
 * deployments set these at build time.
 */
function servers() {
  return [
    { url: process.env.B4M_OPENAPI_PROD_URL ?? 'https://your-deployment.example.com', description: 'Production' },
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
    'Per-operation required scopes are published on each operation via the `x-required-scopes` extension.',
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
 */
function codeSamples(path: string, body: unknown, streaming: boolean) {
  const url = `https://your-deployment.example.com${path}`;
  const json = JSON.stringify(body);
  const pretty = JSON.stringify(body, null, 2);
  const curlFlags = streaming ? '-sN' : '-s';
  const pyStream = streaming ? '\n    stream=True,' : '';
  return [
    {
      lang: 'curl',
      label: 'curl',
      source: `curl ${curlFlags} -X POST "${url}" \\\n  -H "Authorization: Bearer b4m_live_<key>" \\\n  -H "Content-Type: application/json" \\\n  -d '${json}'`,
    },
    {
      lang: 'JavaScript',
      label: 'fetch',
      source:
        `const res = await fetch("${url}", {\n` +
        `  method: "POST",\n` +
        `  headers: {\n    "Authorization": "Bearer b4m_live_<key>",\n    "Content-Type": "application/json",\n  },\n` +
        `  body: JSON.stringify(${pretty}),\n});`,
    },
    {
      lang: 'Python',
      label: 'requests',
      source:
        `import requests\n\n` +
        `res = requests.post(\n    "${url}",\n` +
        `    headers={"Authorization": "Bearer b4m_live_<key>"},\n` +
        `    json=${toPythonLiteral(body)},${pyStream}\n)`,
    },
  ];
}

const CODE_SAMPLES: Record<string, { streaming: boolean; body: unknown }> = {
  createCompletion: {
    streaming: true,
    body: {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'How do I reset my password?' }],
      max_tokens: 500,
    },
  },
  executeTool: { streaming: false, body: { toolName: 'web_search', input: { query: 'how to reset a password' } } },
};

const REQUEST_ID_HEADER_SPEC = {
  'X-Request-ID': {
    description: 'Correlation id for this request; safe to log and quote in support requests.',
    schema: { type: 'string' as const },
  },
};

const RATE_LIMIT_HEADER_SPEC = {
  'X-RateLimit-Limit': { description: 'Request quota for the window.', schema: { type: 'integer' as const } },
  'X-RateLimit-Remaining': {
    description: 'Requests remaining in the window.',
    schema: { type: 'integer' as const },
  },
  'X-RateLimit-Reset': {
    description: 'Unix epoch (seconds) when the window resets.',
    schema: { type: 'integer' as const },
  },
};

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

  doc.tags = [{ name: 'AI', description: 'Completions and server-side tool execution.' }];

  // Attach per-operation vendor extensions + headers by operationId. Restrict to
  // HTTP verbs: a Path Item can also carry summary/description/parameters/servers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- OpenAPI doc is loosely typed for vendor extensions
  const paths = (doc.paths ?? {}) as Record<string, any>;
  for (const pathKey of Object.keys(paths)) {
    for (const method of Object.keys(paths[pathKey])) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = paths[pathKey][method];
      const opId = op?.operationId as keyof typeof REQUIRED_SCOPES | undefined;
      if (!opId) continue;

      if (REQUIRED_SCOPES[opId]) op['x-required-scopes'] = REQUIRED_SCOPES[opId];
      const sample = CODE_SAMPLES[opId];
      if (sample) op['x-codeSamples'] = codeSamples(pathKey, sample.body, sample.streaming);

      for (const status of Object.keys(op.responses ?? {})) {
        const response = op.responses[status];
        response.headers = { ...REQUEST_ID_HEADER_SPEC, ...(response.headers ?? {}) };
        if (opId === 'executeTool') response.headers = { ...response.headers, ...RATE_LIMIT_HEADER_SPEC };
      }
    }
  }

  // Widen to a plain record (see the signature note); the concrete OpenAPIObject
  // has no index signature, so an explicit cast is required.
  return doc as unknown as Record<string, unknown>;
}
