import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';
import { registerContract } from './registerContract';
import type { EndpointContract } from '../api-contract';

// Own module graph per vitest test file, so this fixture registration is the only
// thing on `registry` here - it never touches the real spec built in document.test.ts.
const contract: EndpointContract = {
  method: 'get',
  path: '/api/v1/fixture/{id}/{version}',
  operationId: 'getFixture',
  summary: 'Fixture endpoint for registerContract query-param emission',
  auth: 'public',
  // `version` is `z.coerce.number()`, not `z.string()`, so the pathParams branch of
  // withAccurateCoercedParams is exercised too, not just queryParams: pre-fix, a
  // coerced path param emitted `required: false`, which is invalid OpenAPI (`required`
  // is mandatory for every `in: path` parameter).
  pathParams: z.object({ id: z.string(), version: z.coerce.number() }),
  // `q` proves the plain required/optional case unambiguously. `limit` is
  // `z.coerce.number()`, not `z.number()`, because a real query value always
  // arrives as a string (see the queryParams doc comment in api-contract/types.ts) -
  // kept as its own field because zod-to-openapi documents it surprisingly (see
  // the test below).
  queryParams: z.object({
    q: z.string(),
    limit: z.coerce.number(),
    cursor: z.string().optional(),
    // Exercises undoCoercionForOpenApi's metadata carry-forward: a bare coerce field can
    // still carry its own `.openapi()` call, and rebuilding it from its def must not drop it.
    pageSize: z.coerce.number().openapi({ description: 'Results per page' }),
  }),
  responses: { 200: { description: 'ok', schema: z.object({ ok: z.boolean() }) } },
};

/**
 * The generated doc's own type comes from a transitive dependency (`openapi3-ts`,
 * via `@asteasolutions/zod-to-openapi`), not one of this package's own - so this
 * narrows from `unknown` instead of importing it, rather than adding an
 * undeclared dependency for a type only these tests need.
 */
type FixtureOperation = {
  parameters?: { name: string; in: string; required?: boolean; description?: string; schema?: { type?: unknown } }[];
  responses?: Record<string, unknown>;
};

function getOperation(document: unknown, path: string): FixtureOperation {
  const paths = (document as { paths?: unknown }).paths;
  const pathItem = typeof paths === 'object' && paths !== null ? (paths as Record<string, unknown>)[path] : undefined;
  const operation =
    typeof pathItem === 'object' && pathItem !== null ? (pathItem as Record<string, unknown>).get : undefined;
  if (typeof operation !== 'object' || operation === null) {
    throw new Error(`Expected GET ${path} to be registered in the generated document`);
  }
  return operation as FixtureOperation;
}

registerContract(contract);
const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
  openapi: '3.1.0',
  info: { title: 'fixture', version: '0.0.0' },
});
const operation = getOperation(doc, '/api/v1/fixture/{id}/{version}');

describe('registerContract - queryParams', () => {
  it('documents queryParams as `in: query`, distinct from pathParams as `in: path`', () => {
    const byName = Object.fromEntries((operation.parameters ?? []).map(p => [p.name, p]));
    expect(byName.id).toMatchObject({ in: 'path', required: true });
    expect(byName.q).toMatchObject({ in: 'query', required: true });
    expect(byName.cursor).toMatchObject({ in: 'query', required: false });
  });

  it('documents a required z.coerce.number() query field as required and non-nullable', () => {
    // Verified at runtime: z.coerce.number().safeParse(undefined) FAILS (Number(undefined)
    // is NaN), so `limit` is genuinely required. zod-to-openapi's own requiredness check
    // inspects the coercion's pre-parse input type, which accepts `null` (Number(null) ===
    // 0) - registerContract corrects this before the field reaches zod-to-openapi (see
    // undoCoercionForOpenApi), since an HTTP query value is always a string or absent,
    // never a literal `null`.
    const byName = Object.fromEntries((operation.parameters ?? []).map(p => [p.name, p]));
    expect(byName.limit).toMatchObject({ in: 'query', required: true, schema: { type: 'number' } });
  });

  it('documents a required z.coerce.number() path field as required (pathParams branch, not just queryParams)', () => {
    // A path segment can never be omitted - `required: false` on an `in: path`
    // parameter is invalid OpenAPI, not just imprecise like the query case. Pinned
    // separately from `limit` so withAccurateCoercedParams's pathParams branch has its
    // own coverage instead of relying solely on queryParams's.
    const byName = Object.fromEntries((operation.parameters ?? []).map(p => [p.name, p]));
    expect(byName.version).toMatchObject({ in: 'path', required: true, schema: { type: 'number' } });
  });

  it("keeps a bare z.coerce.* field's own .openapi() metadata after correcting its required/nullable reporting", () => {
    // `.openapi()` metadata is registered against the schema object, not its def - a naive
    // rebuild from the def alone would silently drop it (see undoCoercionForOpenApi).
    const byName = Object.fromEntries((operation.parameters ?? []).map(p => [p.name, p]));
    expect(byName.pageSize).toMatchObject({
      in: 'query',
      required: true,
      description: 'Results per page',
      schema: { type: 'number', description: 'Results per page' },
    });
  });

  it('does not throw for a queryParams object that carries a .refine() alongside a bare coerced field', () => {
    // zod 4's `.extend()` refuses to overwrite keys on an object schema that carries a
    // refinement ("Cannot overwrite keys on object schemas containing refinements. Use
    // .safeExtend() instead."), which withAccurateCoercedParams's rebuild would trigger
    // for a range-check contract like `from <= to`. `.safeExtend()` is the same override,
    // minus that restriction.
    const rangeQuery: EndpointContract = {
      ...contract,
      operationId: 'getFixtureRange',
      path: '/api/v1/fixture-range',
      pathParams: undefined,
      queryParams: z
        .object({ from: z.coerce.number(), to: z.coerce.number() })
        .refine(v => v.from <= v.to, { message: '`from` must not exceed `to`' }),
    };
    expect(() => registerContract(rangeQuery)).not.toThrow();
    const generated = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'fixture', version: '0.0.0' },
    });
    const op = getOperation(generated, '/api/v1/fixture-range');
    const byName = Object.fromEntries((op.parameters ?? []).map(p => [p.name, p]));
    expect(byName.from).toMatchObject({ in: 'query', required: true, schema: { type: 'number' } });
    expect(byName.to).toMatchObject({ in: 'query', required: true, schema: { type: 'number' } });
  });

  it('auto-documents a 422 for a contract with only queryParams (no request body or pathParams)', () => {
    const queryOnly: EndpointContract = {
      ...contract,
      operationId: 'getFixtureQueryOnly',
      path: '/api/v1/fixture-query-only',
      pathParams: undefined,
    };
    registerContract(queryOnly);
    const generated = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: { title: 'fixture', version: '0.0.0' },
    });
    const op = getOperation(generated, '/api/v1/fixture-query-only');
    expect(op.responses?.['422']).toBeDefined();
  });
});
