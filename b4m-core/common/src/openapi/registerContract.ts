import type { z } from 'zod';
import { registry } from './registry';
import { SECURITY_REQUIREMENT, JWT_SECURITY_REQUIREMENT } from './security';
import { ErrorResponse } from './schemas';
// Specific file, not the barrel (`../schemas`): the barrel re-exports actions.ts,
// which imports @bike4mind/hearth - absent in the install-only CI openapi job.
import { ApiErrorSchema } from '../schemas/chat';
import type { EndpointContract } from '../api-contract';

type ContractResponse = { description: string; content: Record<string, { schema: z.ZodTypeAny }> };

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

  const responses: Record<string, ContractResponse> = {};
  for (const [status, spec] of Object.entries(contract.responses)) {
    const contentType = spec.contentType ?? 'application/json';
    // Error bodies reuse the single shared ErrorResponse component ($ref) instead
    // of minting an identical per-operation copy; other schemas get an
    // operation-scoped component so their examples/shape stay endpoint-specific.
    const schema =
      spec.schema === ApiErrorSchema
        ? ErrorResponse
        : spec.schema.openapi(`${contract.operationId}Response${status}`, {
            ...(spec.example !== undefined && { example: spec.example }),
          });
    responses[status] = { description: spec.description, content: { [contentType]: { schema } } };
  }

  // Any NON-streaming contract with a request body OR path params returns 422 on
  // validation failure. Body validation: both adapters guarantee it (Next: ZodError
  // -> errorHandler -> UnprocessableEntity; Lambda: safeParse -> 422). Path-param
  // validation currently only runs on the Next adapter (see the `pathParams` doc
  // comment in api-contract/types.ts) - documenting 422 here regardless is still
  // correct for every contract actually served today. Auto-document it (unless the
  // contract declares its own 422). Streaming endpoints are excluded: they open
  // the stream first, so a bad body arrives as an in-band SSE `error` event, not
  // a 422 JSON body.
  if ((contract.request || contract.pathParams) && !contract.streaming && !responses['422']) {
    responses['422'] = {
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
        content: { 'application/json': { schema: ErrorResponse } },
      };
    }
  }

  const requestSchema = contract.requestDoc ?? contract.request;
  // No `.openapi(name)` here: zod-to-openapi always inlines `request.params` into the
  // operation's `parameters` array rather than a referenceable component, so a name
  // would never appear in the output - passing the schema directly is equivalent and
  // doesn't imply a component that doesn't exist.
  const params = contract.pathParams;

  registry.registerPath({
    method: contract.method,
    path: contract.path,
    operationId: contract.operationId,
    summary: contract.summary,
    description: contract.description,
    tags: contract.tags,
    security,
    request:
      requestSchema || params
        ? {
            ...(params && { params }),
            ...(requestSchema && {
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
            }),
          }
        : undefined,
    responses,
  });
}
