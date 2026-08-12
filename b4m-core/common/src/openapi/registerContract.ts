import type { z } from 'zod';
import { registry } from './registry';
import { SECURITY_REQUIREMENT, JWT_SECURITY_REQUIREMENT } from './security';
import { ErrorResponse } from './schemas';
import type { EndpointContract } from '../api-contract';

type JsonResponse = { description: string; content: { 'application/json': { schema: z.ZodTypeAny } } };

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

  const responses: Record<string, JsonResponse> = {};
  for (const [status, spec] of Object.entries(contract.responses)) {
    responses[status] = {
      description: spec.description,
      content: {
        'application/json': {
          schema: spec.schema.openapi(`${contract.operationId}Response${status}`),
        },
      },
    };
  }

  // Any contract with a request body returns 422 on validation failure - both
  // adapters guarantee it (Next: ZodError -> errorHandler -> UnprocessableEntity;
  // Lambda: safeParse -> 422). Auto-document it (unless the contract declares its
  // own 422) so no author forgets and generated SDKs know the shape.
  if (contract.request && !responses['422']) {
    responses['422'] = {
      description: 'Request body failed validation.',
      content: { 'application/json': { schema: ErrorResponse } },
    };
  }

  // Same reasoning for the auth failures every authenticated route can return:
  // apiKeyAuth 401s a missing/invalid credential and 403s an under-scoped key.
  // Documenting them centrally keeps generated SDKs honest without every author
  // remembering to declare them. A contract may still override either.
  if (contract.auth !== 'public') {
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
  const params = contract.pathParams?.openapi(`${contract.operationId}Params`);

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
