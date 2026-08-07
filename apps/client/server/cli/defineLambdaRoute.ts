import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  type EndpointContract,
  type RequestBodyOf,
  REQUEST_ID_HEADER,
  LEGACY_REQUEST_ID_HEADER,
  resolveRequestId,
} from '@bike4mind/common';
import { connectDB, mongoose } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { resolveContractAuth, type ContractAuthResult } from './resolveContractAuth';

export type LambdaRouteContext<C extends EndpointContract> = {
  validated: RequestBodyOf<C>;
  /** The authenticated caller, per `contract.auth`. Undefined only for `public` contracts. */
  auth?: ContractAuthResult;
  requestId: string;
  event: APIGatewayProxyEventV2;
};

export type LambdaRouteResult = { statusCode: number; body: unknown };

/**
 * Runs after auth resolves and BEFORE contract validation. Throw to reject
 * (the adapter shapes the throw into a 429). Kept out of the handler so the
 * auth -> rate limit -> validation ordering is a property of the adapter, not
 * of where each handler happens to call the limiter - the same guarantee
 * {@link defineNextRoute}'s `rateLimit` option provides.
 */
export type LambdaRateLimit = (ctx: {
  auth?: ContractAuthResult;
  requestId: string;
  event: APIGatewayProxyEventV2;
}) => Promise<void>;

export type LambdaRouteOptions = { rateLimit?: LambdaRateLimit };

/**
 * AWS Lambda Function URL adapter for an {@link EndpointContract} - the transport
 * used for public endpoints the Next.js API can't serve (SST dev + Function URLs +
 * CloudFront had socket hang-ups; see cli/tools.ts).
 *
 * Owns the boilerplate every Function-URL handler repeats: request-id resolution,
 * body parsing (400), DB connect, contract-driven auth (401, via resolveContractAuth
 * so every JWT/API-key gate matches the rest of the app), optional rate limiting
 * (429, via `options.rateLimit`), contract validation (422 - the pattern's uniform
 * validation gate), JSON response shaping, and turning a thrown handler error into a
 * 500 (not an opaque API-gateway 502).
 *
 * Ordering is a hard guarantee the adapter owns: auth -> rate limit -> validation.
 * An unauthenticated caller never triggers validation work or sees validation
 * detail, and an authenticated caller's malformed bodies are metered before they
 * are rejected (so a flood of 422s still counts against the limiter) - the same
 * ordering {@link defineNextRoute} enforces for the Next transport. Business logic
 * stays in the handler, which returns an explicit {statusCode, body}.
 */
export function defineLambdaRoute<C extends EndpointContract>(
  contract: C,
  handle: (ctx: LambdaRouteContext<C>) => Promise<LambdaRouteResult>,
  options: LambdaRouteOptions = {}
): (event: APIGatewayProxyEventV2, resolvedRequestId?: string) => Promise<APIGatewayProxyResultV2> {
  return async (event: APIGatewayProxyEventV2, resolvedRequestId?: string): Promise<APIGatewayProxyResultV2> => {
    // Reuse the wrapper's id when threaded (so both layers report the same value
    // even when the caller sent no header), else resolve from headers / generate.
    const requestId =
      resolvedRequestId ??
      resolveRequestId(
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

    // Auth needs the DB (the verifiers read the user), so connect first, then
    // authenticate per the contract's auth mode - BEFORE validation.
    let auth: ContractAuthResult | undefined;
    if (contract.auth !== 'public') {
      if (mongoose.connection.readyState !== 1) {
        await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), new Logger({ metadata: { requestId } }));
      }
      try {
        auth = await resolveContractAuth(event.headers ?? {}, contract);
      } catch (error) {
        return json(401, {
          error: error instanceof Error ? error.message : 'Authentication failed',
          request_id: requestId,
        });
      }
    }

    // Rate limit AFTER auth (needs the caller identity) but BEFORE validation, so a
    // flood of malformed bodies still counts against the limiter instead of 422ing
    // for free ahead of it.
    if (options.rateLimit) {
      try {
        await options.rateLimit({ auth, requestId, event });
      } catch (error) {
        return json(429, {
          error: error instanceof Error ? error.message : 'Rate limit exceeded',
          request_id: requestId,
        });
      }
    }

    let validated = body as RequestBodyOf<C>;
    if (contract.request) {
      const parsed = contract.request.safeParse(body);
      if (!parsed.success) {
        return json(422, {
          error: 'Request body failed validation',
          request_id: requestId,
          details: parsed.error.issues,
        });
      }
      validated = parsed.data as RequestBodyOf<C>;
    }

    let result: LambdaRouteResult;
    try {
      result = await handle({ validated, auth, requestId, event });
    } catch (error) {
      // A thrown handler error must not surface as an opaque API-gateway 502 -
      // shape it into a 500 with the correlation id. Log it too, or the id in the
      // body has nothing to correlate to in CloudWatch.
      new Logger({ metadata: { requestId } }).error(`[${contract.operationId}] Unhandled handler error`, error);
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
