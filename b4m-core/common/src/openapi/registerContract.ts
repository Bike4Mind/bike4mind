import type { z } from 'zod';
import { getOpenApiMetadata } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';
import { SECURITY_REQUIREMENT, JWT_SECURITY_REQUIREMENT } from './security';
import { ErrorResponse, DEPRECATED_NAME_METADATA } from './schemas';
// Specific file, not the barrel (`../schemas`): the barrel re-exports actions.ts,
// which imports @bike4mind/hearth - absent in the install-only CI openapi job.
import { ApiErrorSchema, ScopeForbiddenErrorSchema } from '../schemas/chat';
import type { EndpointContract } from '../api-contract';

type ContractSchema = z.ZodTypeAny | { type: 'string'; contentEncoding: 'binary' };
type ContractResponse = {
  description: string;
  content?: Record<string, { schema: ContractSchema }>;
  headers?: Record<string, { description: string; schema: { type: 'string' } }>;
};

/**
 * OpenAPI 3.1 (JSON Schema 2020-12) spelling for "opaque bytes"; 3.0's
 * `format: 'binary'` is not a JSON Schema keyword and is ignored by 3.1 tooling.
 * Used for a response whose contract declares no `schema` - a raw body has no
 * JSON shape to model, only a media type.
 */
const BINARY_SCHEMA = { type: 'string', contentEncoding: 'binary' } as const;

/**
 * Re-apply the deprecation to a `name` a bespoke error schema inherited from
 * `ApiErrorSchema` (see CONVENTIONS.md section 1: those extend the envelope rather than
 * re-declaring it). `.extend()` carries the field through as a plain optional string, so
 * without this the sunset notice would appear on the shared `ErrorResponse` component and
 * nowhere else. Keyed on field *identity*, not the name `name`, so a schema that declares
 * a `name` of its own - a person's name, say - is left alone.
 */
function annotateInheritedName(schema: z.ZodTypeAny): z.ZodTypeAny {
  // Structural rather than `z.ZodObject`: that type's shape values widen to $ZodType,
  // which does not carry the `.openapi()` augmentation.
  const objectSchema = schema as unknown as {
    shape?: Record<string, z.ZodTypeAny>;
    extend?: (shape: Record<string, z.ZodTypeAny>) => z.ZodTypeAny;
  };
  const inherited = objectSchema.shape?.name;
  if (!inherited || inherited !== ApiErrorSchema.shape.name || !objectSchema.extend) return schema;
  return objectSchema.extend({ name: inherited.openapi(DEPRECATED_NAME_METADATA) });
}

/** The auto-injected scope 403's body: one shared component, $ref'd by every operation. */
const SCOPE_FORBIDDEN_RESPONSE = annotateInheritedName(ScopeForbiddenErrorSchema).openapi('ScopeForbiddenResponse');

/**
 * zod-to-openapi derives a parameter's `required`/nullable-ness from
 * `schema.safeParse(undefined)`/`schema.safeParse(null)` (its `isOptionalSchema`/
 * `isNullableSchema`). For a bare `z.coerce.*` field this is wrong: `Number(null)`,
 * `String(null)`, etc. all coerce successfully, so a genuinely required
 * `z.coerce.number()` query param gets documented as optional and nullable
 * (`type: ['number', 'null']`) even though an HTTP query/path value is always either
 * a string or absent - never a literal JSON `null`.
 *
 * Rather than reimplement zod-to-openapi's required/nullable/type/format/checks
 * derivation, hand it a same-shaped schema with `coerce` turned off - `def.checks`/
 * `def.format` carry over untouched, so only the required/nullable reporting changes.
 * Only a *bare* `z.coerce.*` field is touched: `.optional()`/`.nullable()`/`.default()`
 * wrap it in an outer node whose own `def.coerce` is undefined, so a deliberately
 * optional or nullable coerced field is left alone.
 *
 * `.openapi()` metadata (description, example, a `param` override, ...) is registered
 * against the schema *object*, not its def, so a fresh instance built straight from the
 * def would silently lose whatever the field's own `.openapi()` call attached - carry
 * it forward explicitly.
 */
function undoCoercionForOpenApi(schema: z.ZodTypeAny): z.ZodTypeAny {
  const internals = (schema as unknown as { _zod?: { def?: Record<string, unknown> } })._zod;
  if (internals?.def?.coerce !== true) return schema;
  // `.clone(def)` is zod v4's own supported rebuild path (unlike reflecting on
  // `schema.constructor`, which assumes a `(def) => instance` signature zod doesn't
  // promise to keep) - `_zod.def` is still fine to read, that part is documented
  // library-author-facing internals.
  const cloneable = schema as unknown as { clone: (def: Record<string, unknown>) => z.ZodTypeAny };
  const cloned = cloneable.clone({ ...internals.def, coerce: false });
  return cloned.openapi(getOpenApiMetadata(schema));
}

/**
 * Apply {@link undoCoercionForOpenApi} across a `pathParams`/`queryParams` object
 * schema's fields. Structural rather than plain `z.ZodObject` access for the same
 * reason as {@link annotateInheritedName}: shape values widen to `$ZodType`, which
 * does not carry `.safeExtend()`'s precise return type - cast back to `T` at the end,
 * since `.safeExtend()` on a `ZodObject` always yields another `ZodObject`. `.safeExtend()`
 * rather than `.extend()`: zod 4 refuses to overwrite keys with `.extend()` on an object
 * that carries a `.refine()` (e.g. a `from <= to` range check), and throws at spec
 * generation instead - `.safeExtend()` is the same override, minus that restriction.
 */
function withAccurateCoercedParams<T extends z.ZodObject<z.ZodRawShape>>(objectSchema: T | undefined): T | undefined {
  const shapeAndExtend = objectSchema as unknown as
    | { shape?: Record<string, z.ZodTypeAny>; safeExtend?: (shape: Record<string, z.ZodTypeAny>) => z.ZodTypeAny }
    | undefined;
  if (!shapeAndExtend?.shape || !shapeAndExtend.safeExtend) return objectSchema;
  const overrides: Record<string, z.ZodTypeAny> = {};
  for (const [key, fieldSchema] of Object.entries(shapeAndExtend.shape)) {
    const fixed = undoCoercionForOpenApi(fieldSchema);
    if (fixed !== fieldSchema) overrides[key] = fixed;
  }
  return Object.keys(overrides).length > 0 ? (shapeAndExtend.safeExtend(overrides) as T) : objectSchema;
}

/**
 * Register a transport-agnostic {@link EndpointContract} as an OpenAPI operation.
 *
 * This is the ONLY place a contract's schemas meet `.openapi()` - safe here
 * because this module imports ./registry, which runs `extendZodWithOpenApi`.
 * Runs at generate time only.
 */
export function registerContract(contract: EndpointContract): void {
  // A public operation gets an explicit empty list: omitting `security` fails redocly's security-defined rule.
  const security =
    contract.auth === 'jwtOnly' ? JWT_SECURITY_REQUIREMENT : contract.auth === 'public' ? [] : SECURITY_REQUIREMENT;

  // Error bodies reuse the single shared ErrorResponse (or, for a declared scope 403,
  // ScopeForbiddenResponse) component ($ref) instead of
  // minting an identical per-operation copy; other schemas get an operation-scoped
  // component so their examples/shape stay endpoint-specific. A body with no schema
  // is raw bytes, which have only a media type.
  const componentSchema = (
    body: { schema?: z.ZodTypeAny; example?: unknown },
    componentName: string
  ): ContractSchema =>
    !body.schema
      ? BINARY_SCHEMA
      : body.schema === ApiErrorSchema
        ? ErrorResponse
        : body.schema === ScopeForbiddenErrorSchema
          ? SCOPE_FORBIDDEN_RESPONSE
          : annotateInheritedName(body.schema).openapi(componentName, {
              ...(body.example !== undefined && { example: body.example }),
            });

  const responses: Record<string, ContractResponse> = {};
  for (const [status, spec] of Object.entries(contract.responses)) {
    const content: Record<string, { schema: ContractSchema }> = {
      [spec.contentType ?? 'application/json']: {
        schema: componentSchema(spec, `${contract.operationId}Response${status}`),
      },
    };
    spec.alsoReturns?.forEach((body, i) => {
      content[body.contentType] = { schema: componentSchema(body, `${contract.operationId}Response${status}Alt${i}`) };
    });

    // A poll result is a different operation's body, so it is registered as a
    // standalone component rather than content of this status: the description
    // points a caller at it. zod-to-openapi emits every registered definition,
    // referenced or not.
    if (spec.pollResult) {
      // Keyed by status, not just operationId: two statuses on one contract both
      // declaring pollResult would otherwise register the same component name twice,
      // and whichever registration ran last would silently win for both responses.
      const pollResultName = `${contract.operationId}${status}PollResult`;
      registry.register(
        pollResultName,
        spec.pollResult.schema.openapi(pollResultName, {
          description: spec.pollResult.description,
          ...(spec.pollResult.example !== undefined && { example: spec.pollResult.example }),
        })
      );
    }

    responses[status] = {
      description: spec.description,
      ...(!spec.noBody && { content }),
      ...(spec.headers && {
        headers: Object.fromEntries(
          Object.entries(spec.headers).map(([name, description]) => [
            name,
            { description, schema: { type: 'string' as const } },
          ])
        ),
      }),
    };
  }

  // Any NON-streaming contract with a request body, path params, or query params
  // documents its validation failure status. 422 is the default; legacy routes can
  // preserve a published 400 with validationErrorStatus.
  // Streaming endpoints are excluded: they open the stream first, so a bad body
  // arrives as an in-band SSE `error` event, not a JSON error body.
  const validationStatus = contract.validationErrorStatus ?? 422;
  if (
    (contract.request || contract.pathParams || contract.queryParams) &&
    !contract.streaming &&
    !responses[String(validationStatus)]
  ) {
    responses[String(validationStatus)] = {
      description: 'Request failed validation.',
      content: { 'application/json': { schema: ErrorResponse } },
    };
  }

  // Same reasoning for the auth failures every authenticated route can return:
  // apiKeyAuth 401s a missing/invalid credential and 403s an under-scoped key.
  // Documenting them centrally keeps generated SDKs honest without every author
  // remembering to declare them. Streaming endpoints are excluded: once the
  // stream opens the status stays 200 and auth/scope failures arrive as an
  // in-band SSE `error` event, not an HTTP 401/403. A contract may still
  // override either.
  if (contract.auth !== 'public' && !contract.streaming) {
    if (!responses['401']) {
      responses['401'] = {
        description: 'Missing or invalid credentials.',
        content: { 'application/json': { schema: ErrorResponse } },
      };
    }
    if (contract.scopes?.length && !responses['403']) {
      responses['403'] = {
        description: 'The API key does not hold any of the required scopes.',
        content: { 'application/json': { schema: SCOPE_FORBIDDEN_RESPONSE } },
      };
    }
  }

  // Every transport 405s any method but the contract's own, ahead of auth and before a stream
  // opens (baseApi's `allowedMethods` for Next, defineLambdaRoute's guard for Function URLs, and
  // the completions route's own guard on the ChatCompletion Express app), so this holds for public
  // and streaming contracts too. A new transport must install the same guard or this is false.
  if (!responses['405']) {
    responses['405'] = {
      description: 'The path does not serve this HTTP method.',
      content: { 'application/json': { schema: ErrorResponse } },
      headers: {
        Allow: {
          description: 'The methods this path serves. GET implies HEAD.',
          schema: { type: 'string' },
        },
      },
    };
  }

  const requestSchema = contract.request;
  // No `.openapi(name)` here: zod-to-openapi always inlines `request.params`/
  // `request.query` into the operation's `parameters` array rather than a
  // referenceable component, so a name would never appear in the output - passing
  // the schema directly is equivalent and doesn't imply a component that doesn't
  // exist.
  const params = withAccurateCoercedParams(contract.pathParams);
  const query = withAccurateCoercedParams(contract.queryParams);

  registry.registerPath({
    method: contract.method,
    path: contract.path,
    operationId: contract.operationId,
    summary: contract.summary,
    description: contract.description,
    tags: contract.tags,
    security,
    request:
      requestSchema || params || query
        ? {
            ...(params && { params }),
            ...(query && { query }),
            ...(requestSchema && {
              body: {
                required: contract.requestBodyRequired ?? true,
                content: {
                  'application/json': {
                    schema: requestSchema.openapi(`${contract.operationId}Request`, {
                      ...(contract.requestExample !== undefined && { example: contract.requestExample }),
                    }),
                  },
                },
              },
            }),
          }
        : undefined,
    responses,
  });
}
