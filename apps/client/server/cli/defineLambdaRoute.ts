import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  type EndpointContract,
  type RequestBodyOf,
  REQUEST_ID_HEADER,
  LEGACY_REQUEST_ID_HEADER,
  resolveRequestId,
} from '@bike4mind/common';

export type LambdaRouteContext<C extends EndpointContract> = {
  validated: RequestBodyOf<C>;
  requestId: string;
  event: APIGatewayProxyEventV2;
};

export type LambdaRouteResult = { statusCode: number; body: unknown };

/**
 * AWS Lambda Function URL adapter for an {@link EndpointContract} - the transport
 * used for the public endpoints that can't be served by the Next.js API
 * (SST dev + Function URLs + CloudFront had socket hang-ups; see cli/tools.ts).
 *
 * It handles the boilerplate every Function-URL handler repeats today: request-id
 * resolution, body parsing, contract validation (SAME schema the Next adapter and
 * OpenAPI spec use), JSON response shaping, and turning a thrown handler error into
 * a 500 (rather than letting it surface as an opaque API-gateway 502). The business
 * logic stays in the shared module the handler delegates to.
 *
 * IMPORTANT - this adapter does NOT yet enforce `contract.auth` / `contract.scopes`.
 * It has no non-test callers on this branch; the auth wiring (via resolveContractAuth,
 * mirroring the verifyJwtToken/apiKey flow in cli/tools.ts) and the first real
 * Lambda-served contract land in the follow-up that migrates completions + tools.
 * Until then, do NOT route a non-public contract through this adapter and assume
 * auth is handled - it is not.
 */
export function defineLambdaRoute<C extends EndpointContract>(
  contract: C,
  handle: (ctx: LambdaRouteContext<C>) => Promise<LambdaRouteResult>
): (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const requestId = resolveRequestId(
      event.headers?.[REQUEST_ID_HEADER.toLowerCase()],
      event.headers?.[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
    );

    const json = (statusCode: number, payload: unknown): APIGatewayProxyResultV2 => ({
      statusCode,
      headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
      body: JSON.stringify(payload),
    });

    let body: unknown;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch {
      return json(400, { error: 'Invalid request body', request_id: requestId });
    }

    if (contract.request) {
      const parsed = contract.request.safeParse(body);
      if (!parsed.success) {
        return json(422, { error: 'Validation failed', request_id: requestId });
      }
      body = parsed.data;
    }

    let result: LambdaRouteResult;
    try {
      result = await handle({ validated: body as RequestBodyOf<C>, requestId, event });
    } catch (error) {
      // A thrown handler error must not surface as an opaque API-gateway 502 -
      // shape it into a 500 with the correlation id so the caller/logs can trace it.
      return json(500, {
        error: error instanceof Error ? error.message : 'Internal server error',
        request_id: requestId,
      });
    }

    // Non-prod safety net (see defineNextRoute): warn on a response body that does
    // not match the contract for that status. Warn-only, wrapped, prod-compiled-out.
    if (process.env.NODE_ENV !== 'production') {
      try {
        const spec = contract.responses[result.statusCode];
        const check = spec?.schema.safeParse(result.body);
        if (check && !check.success) {
          console.warn(
            `[contract] ${contract.operationId} response ${result.statusCode} violates schema: ${check.error.message}`
          );
        }
      } catch {
        // never let a dev assertion affect the response
      }
    }

    return json(result.statusCode, result.body);
  };
}
