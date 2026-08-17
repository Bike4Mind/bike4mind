import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildOpenApiDocument, toPythonLiteral } from './document';
import { registerContracts } from './operations';
import { assertUniqueOperations } from './assertUniqueOperations';
import { assertContractConventions } from '../api-contract/assertContractConventions';
import { ApiKeyScope } from '../types/entities/UserApiKeyTypes';
import { chatContract, synthesizeSpeechContract } from '../api-contract';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
const doc = buildOpenApiDocument('9.9.9') as any;
const completions = doc.paths['/api/ai/v1/completions'].post;
const tools = doc.paths['/api/ai/v1/tools'].post;
const chat = doc.paths['/api/chat'].post;
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

describe('buildOpenApiDocument', () => {
  it('emits an OpenAPI 3.1 document with the API version', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('9.9.9');
    expect(doc.info.title).toBe('Bike4Mind API');
  });

  it('populates info completeness: contact, license, servers, tags', () => {
    expect(doc.info.contact).toBeDefined();
    expect(doc.info.license?.name).toBeTruthy();
    expect(doc.servers.map((s: { description: string }) => s.description)).toEqual([
      'Production',
      'Staging',
      'Local dev',
    ]);
    expect(doc.tags.map((t: { name: string }) => t.name)).toContain('AI');
  });

  it('declares both /v1 operations with stable camelCase operationIds + summary + description', () => {
    for (const op of [completions, tools]) {
      expect(op.summary).toBeTruthy();
      expect(op.description).toBeTruthy();
    }
    expect(completions.operationId).toBe('createCompletion');
    expect(tools.operationId).toBe('executeTool');
  });

  it('declares the security schemes and requires the right one per operation', () => {
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKeyAuth', 'bearerAuth', 'jwtAuth']);
    // Completions accepts an API key (either header) OR a JWT.
    expect(completions.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    // Tools is JWT-only - its handler rejects b4m_live_ keys, so no apiKeyAuth here.
    expect(tools.security).toEqual([{ jwtAuth: [] }]);
    expect(JSON.stringify(tools.security)).not.toContain('apiKeyAuth');
  });

  it('models the completions response as an SSE stream referencing the stream-event component', () => {
    const ok = completions.responses['200'];
    expect(Object.keys(ok.content)).toEqual(['text/event-stream']);
    expect(ok.content['text/event-stream'].schema).toEqual(ref('createCompletionResponse200'));
  });

  it('wires request bodies and responses via $ref (no inline duplication)', () => {
    expect(completions.requestBody.content['application/json'].schema).toEqual(ref('createCompletionRequest'));
    expect(tools.requestBody.content['application/json'].schema).toEqual(ref('executeToolRequest'));
    // 4xx references the shared error envelope; tools 500 returns the full result body.
    expect(completions.responses['400'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(tools.responses['400'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(tools.responses['200'].content['application/json'].schema).toEqual(ref('executeToolResponse200'));
    expect(tools.responses['500'].content['application/json'].schema).toEqual(ref('executeToolResponse500'));
  });

  it('provides request AND response examples for both operations', () => {
    expect(doc.components.schemas.createCompletionRequest.example).toBeDefined();
    expect(doc.components.schemas.createCompletionResponse200.example).toBeDefined();
    expect(doc.components.schemas.executeToolRequest.example).toBeDefined();
    expect(doc.components.schemas.executeToolResponse200.example).toBeDefined();
  });

  it('attaches x-required-scopes ONLY where scopes are enforced, x-codeSamples on both', () => {
    // createCompletion enforces scopes (verifyApiKey); executeTool does not (JWT-only).
    expect(completions['x-required-scopes']).toContain(ApiKeyScope.AI_CHAT);
    expect(tools['x-required-scopes']).toBeUndefined();
    for (const op of [completions, tools]) {
      expect(op['x-codeSamples'].map((s: { lang: string }) => s.lang)).toEqual(['curl', 'JavaScript', 'Python']);
    }
  });

  it('derives x-required-scopes AND x-codeSamples for a CONTRACT-based op from the contract itself', () => {
    // Guards against spec-only drift: the contract-derived operation must publish
    // exactly the contract's scopes + code samples. This catches a published-vs-
    // enforced mismatch that runtime tests can't (e.g. dropping the CONTRACTS spread
    // in document.ts strips x-required-scopes while every runtime test still passes).
    expect(chat.operationId).toBe(chatContract.operationId);
    expect(chat['x-required-scopes']).toEqual([...(chatContract.scopes ?? [])]);
    expect(chat['x-required-scopes'].length).toBeGreaterThan(0);
    expect(chat['x-codeSamples'].map((s: { lang: string }) => s.lang)).toEqual(['curl', 'JavaScript', 'Python']);
  });

  it('documents tools 401/429 and JWT-only code samples (matches the JWT-only handler)', () => {
    expect(tools.responses['401'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(tools.responses['429'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    // completions surfaces auth/rate errors as in-band SSE, so it must NOT declare HTTP 401/429.
    expect(completions.responses['401']).toBeUndefined();
    expect(completions.responses['429']).toBeUndefined();
    // Tools code samples must show a JWT bearer, never a b4m_live_ API key.
    const toolsCurl = tools['x-codeSamples'].find((s: { lang: string }) => s.lang === 'curl').source as string;
    expect(toolsCurl).toContain('Bearer <access_token>');
    expect(toolsCurl).not.toContain('b4m_live_');
  });

  it('auto-injects 401 (and 403 for scoped ops) on non-streaming authenticated endpoints', () => {
    // Guards the central auth-response injection in registerContract. chatContract
    // declares neither 401 nor 403 itself, so both come purely from the injection;
    // dropping it silently narrows /api/chat's published spec and generated SDKs
    // stop modelling the missing-credential / under-scoped-key paths.
    expect(chat.responses['401'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(chat.responses['403'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    // Streaming completions opens the stream first, so auth/scope failures are
    // in-band SSE events - it must NOT declare HTTP 401/403 even though it is
    // authenticated and scoped.
    expect(completions.responses['401']).toBeUndefined();
    expect(completions.responses['403']).toBeUndefined();
  });

  it('documents OR semantics for required scopes in info.description', () => {
    expect(doc.info.description.toLowerCase()).toContain('any one');
  });

  it('emits streaming affordances only for the streaming endpoint', () => {
    const sampleSource = (op: typeof completions, lang: string) =>
      op['x-codeSamples'].find((s: { lang: string }) => s.lang === lang).source as string;
    // Completions streams: curl -sN + Python stream=True.
    expect(sampleSource(completions, 'curl')).toContain('-sN');
    expect(sampleSource(completions, 'Python')).toContain('stream=True');
    // Tools is plain JSON: neither.
    expect(sampleSource(tools, 'curl')).not.toContain('-sN');
    expect(sampleSource(tools, 'Python')).not.toContain('stream=True');
  });

  it('escapes the curl body via a quoted heredoc so a single quote cannot break the shell string', () => {
    const curl = (op: typeof completions) =>
      op['x-codeSamples'].find((s: { lang: string }) => s.lang === 'curl').source as string;
    for (const op of [completions, tools]) {
      const source = curl(op);
      // Body is piped in, not inlined as -d '...': a quote in the JSON is now safe.
      expect(source).toContain("--data-binary @- <<'B4M_REQUEST_BODY'");
      expect(source).toContain('\nB4M_REQUEST_BODY');
      expect(source).not.toContain("-d '");
    }
  });

  it('sources the code-sample URL from the same env as servers() (B4M_OPENAPI_PROD_URL)', () => {
    const original = process.env.B4M_OPENAPI_PROD_URL;
    process.env.B4M_OPENAPI_PROD_URL = 'https://api.test.example';
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
      const rebuilt = buildOpenApiDocument('9.9.9') as any;
      expect(rebuilt.servers[0].url).toBe('https://api.test.example');
      const curl = rebuilt.paths['/api/ai/v1/completions'].post['x-codeSamples'].find(
        (s: { lang: string }) => s.lang === 'curl'
      ).source as string;
      expect(curl).toContain('https://api.test.example/api/ai/v1/completions');
    } finally {
      if (original === undefined) delete process.env.B4M_OPENAPI_PROD_URL;
      else process.env.B4M_OPENAPI_PROD_URL = original;
    }
  });

  it('renders Python literals without mangling string values that contain true/false/null', () => {
    expect(toPythonLiteral(true)).toBe('True');
    expect(toPythonLiteral(false)).toBe('False');
    expect(toPythonLiteral(null)).toBe('None');
    // A string that literally contains those words must survive verbatim.
    expect(toPythonLiteral({ query: 'is this true or null' })).toContain('"is this true or null"');
    expect(toPythonLiteral({ query: 'is this true or null' })).not.toContain('True or None');
  });

  it('publishes the real ApiKeyScope vocabulary in info.description', () => {
    expect(doc.info.description).toContain(ApiKeyScope.AI_CHAT);
    expect(doc.info.description).toContain(ApiKeyScope.READ_FILES);
    // The aspirational vocab from the issue must NOT leak in (Decision 2).
    expect(doc.info.description).not.toContain('ai.completions:write');
  });

  it('declares X-Request-ID on every response', () => {
    expect(completions.responses['200'].headers['X-Request-ID']).toBeDefined();
    expect(tools.responses['200'].headers['X-Request-ID']).toBeDefined();
    expect(chat.responses['200'].headers['X-Request-ID']).toBeDefined();
  });

  it('publishes the WINDOWED rate-limit header names the middleware actually sets', () => {
    // The unwindowed spelling is what the spec used to publish; nothing sets it,
    // so a client coding against it reads undefined.
    for (const window of ['Minute', 'Day']) {
      for (const field of ['Limit', 'Remaining', 'Reset']) {
        expect(chat.responses['200'].headers[`X-RateLimit-${field}-${window}`]).toBeDefined();
      }
    }
    expect(chat.responses['200'].headers['X-RateLimit-Limit']).toBeUndefined();
  });

  it('attaches rate-limit headers only where the contract declares them', () => {
    // tools is JWT-only on the Lambda adapter and completions is the Fargate SSE
    // route: neither sets a rate-limit header, so neither may publish one.
    expect(tools.responses['200'].headers['X-RateLimit-Limit-Minute']).toBeUndefined();
    expect(completions.responses['200'].headers['X-RateLimit-Limit-Minute']).toBeUndefined();
    // Every baseApi-served endpoint does emit them. This list is deliberately
    // spelled out rather than derived from the flag: enumerating the real
    // baseApi-served surface is what catches a contract that forgot to declare it,
    // which is how PUT /api/sessions/{id} shipped without the flag.
    const baseApiServed: readonly [string, string][] = [
      ['/api/ai/tts', 'post'],
      ['/api/ai/music', 'post'],
      ['/api/ai/sound-effects', 'post'],
      ['/api/sessions/{id}', 'put'],
    ];
    for (const [path, method] of baseApiServed) {
      const headers = doc.paths[path][method].responses['200'].headers;
      expect(headers['X-RateLimit-Limit-Minute'], `${method.toUpperCase()} ${path}`).toBeDefined();
    }
  });

  it('excludes rate-limit headers from the INJECTED 401/403 but keeps them on a contract-declared 401', () => {
    // chat declares neither status: both come from registerContract's auth injection
    // and mean "apiKeyAuth rejected the credential", which happens before
    // apiKeyRateLimit runs - so those responses genuinely carry no rate-limit headers.
    expect(chat.responses['401'].headers['X-RateLimit-Limit-Minute']).toBeUndefined();
    expect(chat.responses['403'].headers['X-RateLimit-Limit-Minute']).toBeUndefined();
    // tts declares its OWN 401 (provider_not_configured), thrown from the handler
    // long after the middleware set all six. A status-keyed exclusion would have
    // published it as header-less, which is the same spec-vs-runtime drift as the
    // unwindowed names above.
    expect(synthesizeSpeechContract.responses[401]).toBeDefined();
    const tts = doc.paths['/api/ai/tts'].post;
    for (const window of ['Minute', 'Day']) {
      expect(tts.responses['401'].headers[`X-RateLimit-Limit-${window}`]).toBeDefined();
    }
  });

  it('emits no orphaned component schemas (every schema is $ref-ed somewhere)', () => {
    // Mirrors redocly no-unused-components: a registered-but-never-referenced
    // component is dead weight and confuses SDK generators. Sub-schemas that
    // CompletionRequest composes are inlined, not registered, on purpose.
    const names = Object.keys(doc.components.schemas);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // A schema may legitimately $ref another schema in its own definition, so
      // exclude that definition before checking the rest of the document.
      const { [name]: _self, ...others } = doc.components.schemas;
      const rest = JSON.stringify({ paths: doc.paths, schemas: others });
      expect(rest, `component ${name} is never referenced`).toContain(`#/components/schemas/${name}`);
    }
  });
});

// The guards are called from operations.ts at module scope. Testing them directly
// proves they WORK; this proves they are actually WIRED - delete either call in
// registerContracts and these fail, which was not true when they were inlined.
//
// Only the REJECTING cases may go through registerContracts. It writes into the
// module-global registry and zod-openapi's `definitions` getter returns a copy, so
// there is no removal API: a conforming contract would leave a phantom
// /api/v1/widgets operation behind for anything that builds a document afterwards.
// That is invisible today only because `doc` above is built at module load, before
// any test body runs - which is exactly the trap. The positive control therefore
// calls the two guards directly, registering nothing.
describe('registerContracts wiring', () => {
  const conformingContract = {
    method: 'post' as const,
    path: '/api/v1/widgets',
    operationId: 'createWidget',
    summary: 'Create a widget',
    auth: 'apiKeyOrJwt' as const,
    scopes: [ApiKeyScope.AI_GENERATE],
    responses: { 200: { description: 'Created.', schema: z.object({ id: z.string() }) } },
  };

  it('runs the conventions guard before registering', () => {
    expect(() => registerContracts([{ ...conformingContract, path: '/api/widgets' }])).toThrow(/version root/);
  });

  it('runs the uniqueness guard before registering', () => {
    expect(() => registerContracts([conformingContract, conformingContract])).toThrow(/Duplicate operationId/);
  });

  it('rejects those two for the injected violation, not for the fixture itself', () => {
    // Without this control, both throws above would still pass if the fixture were
    // independently non-conforming and the guards were rejecting everything.
    const { operationId, method, path } = conformingContract;
    expect(() => assertUniqueOperations([{ operationId, method, path }])).not.toThrow();
    expect(() => assertContractConventions([conformingContract])).not.toThrow();
  });
});
