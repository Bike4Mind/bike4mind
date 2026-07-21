import { describe, it, expect } from 'vitest';
import { buildOpenApiDocument, toPythonLiteral } from './document';
import { ApiKeyScope } from '../types/entities/UserApiKeyTypes';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- spec doc is loosely typed for traversal
const doc = buildOpenApiDocument('9.9.9') as any;
const completions = doc.paths['/api/ai/v1/completions'].post;
const tools = doc.paths['/api/ai/v1/tools'].post;
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

  it('declares both security schemes and requires them per operation', () => {
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(['apiKeyAuth', 'bearerAuth']);
    for (const op of [completions, tools]) {
      expect(op.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    }
  });

  it('models the completions response as an SSE stream referencing the stream-event component', () => {
    const ok = completions.responses['200'];
    expect(Object.keys(ok.content)).toEqual(['text/event-stream']);
    expect(ok.content['text/event-stream'].schema).toEqual(ref('CompletionStreamEvent'));
  });

  it('wires request bodies and responses via $ref (no inline duplication)', () => {
    expect(completions.requestBody.content['application/json'].schema).toEqual(ref('CompletionRequest'));
    expect(tools.requestBody.content['application/json'].schema).toEqual(ref('ToolExecutionRequest'));
    // 4xx references the shared error envelope; tools 500 returns the full result body.
    expect(completions.responses['400'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(tools.responses['400'].content['application/json'].schema).toEqual(ref('ErrorResponse'));
    expect(tools.responses['200'].content['application/json'].schema).toEqual(ref('ToolExecutionResponse'));
    expect(tools.responses['500'].content['application/json'].schema).toEqual(ref('ToolExecutionResponse'));
  });

  it('provides request AND response examples for both operations', () => {
    expect(doc.components.schemas.CompletionRequest.example).toBeDefined();
    expect(doc.components.schemas.CompletionStreamEvent.example).toBeDefined();
    expect(doc.components.schemas.ToolExecutionRequest.example).toBeDefined();
    expect(doc.components.schemas.ToolExecutionResponse.example).toBeDefined();
  });

  it('attaches per-operation vendor extensions to BOTH operations', () => {
    for (const op of [completions, tools]) {
      expect(op['x-required-scopes']).toContain(ApiKeyScope.AI_CHAT);
      expect(op['x-codeSamples'].map((s: { lang: string }) => s.lang)).toEqual(['curl', 'JavaScript', 'Python']);
    }
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

  it('declares X-Request-ID on every response and rate-limit headers on tools', () => {
    expect(completions.responses['200'].headers['X-Request-ID']).toBeDefined();
    expect(tools.responses['200'].headers['X-RateLimit-Limit']).toBeDefined();
  });
});
