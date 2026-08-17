import type { z } from 'zod';
import { registry } from './registry';
import { SECURITY_REQUIREMENT, JWT_SECURITY_REQUIREMENT } from './security';
import { ErrorResponse } from './schemas';
// Specific file, not the barrel (`../schemas`): the barrel re-exports actions.ts,
// which imports @bike4mind/hearth - absent in the install-only CI openapi job.
import { ApiErrorSchema } from '../schemas/chat';
import type { EndpointContract } from '../api-contract';

type ContractSchema = z.ZodTypeAny | { type: 'string'; contentEncoding: 'binary' };
type ContractResponse = {
  description: string;
  content: Record<string, { schema: ContractSchema }>;
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
 * Register a transport-agnostic {@link EndpointContract} as an OpenAPI operation.
 *
 * This is the ONLY place a contract's schemas meet `.openapi()` - safe here
 * because this module imports ./registry, which runs `extendZodWithOpenApi`.
 * Runs at generate time only. The request body uses `requestDoc` when present
 * (the OpenAPI-representable projection) and falls back to `request`.
 */
export function registerContract(contract: EndpointContract): void {
  const security =
    contract.auth === 'jwtOnly'
      ? JWT_SECURITY_REQUIREMENT
      : contract.auth === 'public'
        ? undefined
        : SECURITY_REQUIREMENT;

  // Error bodies reuse the single shared ErrorResponse component ($ref) instead of
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
        : body.schema.openapi(componentName, {
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

    responses[status] = {
      description: spec.description,
      content,
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

  // Any NON-streaming contract with a request body returns 422 on validation
  // failure - both adapters guarantee it (Next: ZodError -> errorHandler ->
  // UnprocessableEntity; Lambda: safeParse -> 422). Auto-document it (unless the
  // contract declares its own 422). Streaming endpoints are excluded: they open
  // the stream first, so a bad body arrives as an in-band SSE `error` event, not
  // a 422 JSON body.
  if (contract.request && !contract.streaming && !responses['422']) {
    responses['422'] = {
      description: 'Request body failed validation.',
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
        content: { 'application/json': { schema: ErrorResponse } },
      };
    }
  }

  const requestSchema = contract.requestDoc ?? contract.request;

  registry.registerPath({
    method: contract.method,
    path: contract.path,
    operationId: contract.operationId,
    summary: contract.summary,
    description: contract.description,
    tags: contract.tags,
    security,
    request: requestSchema
      ? {
          body: {
            required: true,
            content: {
              'application/json': {
                schema: requestSchema.openapi(`${contract.operationId}Request`, {
                  ...(contract.requestExample !== undefined && { example: contract.requestExample }),
                }),
              },
            },
          },
        }
      : undefined,
    responses,
  });
}
