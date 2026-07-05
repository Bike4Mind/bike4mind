import { Logger } from '@bike4mind/observability';
import { Config } from '@server/utils/config';
import { connectDB, mongoose } from '@bike4mind/database';
import { verifyJwtToken, checkRateLimit } from './auth';
import { validateToolRequest, executeToolWithLogging } from './toolsHandler.shared';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { LEGACY_REQUEST_ID_HEADER, REQUEST_ID_HEADER, resolveRequestId } from '@bike4mind/common';

/**
 * Lambda handler for CLI server-side tool execution (production & preview).
 *
 * Thin wrapper around shared business logic in toolsHandler.shared.ts.
 * Local dev uses the Next.js API route instead:
 * @see apps/client/pages/api/ai/v1/tools.ts
 *
 * WHY dual implementation? SST dev + Lambda Function URLs + CloudFront
 * router causes socket hang ups; Next.js API works reliably in local dev.
 *
 * All business logic must stay in toolsHandler.shared.ts - this file and
 * the Next.js API are thin wrappers only.
 */
export async function handleToolRequest(
  event: APIGatewayProxyEventV2,
  // Pre-resolved by the wrapper handler so both layers report the same ID.
  // Falls back to resolving here when invoked directly.
  resolvedRequestId?: string
): Promise<APIGatewayProxyResultV2> {
  const logger = new Logger();

  // Correlation ID - reuse the wrapper's value, or accept the caller's
  // (sanitized) / generate one when called directly.
  const requestId =
    resolvedRequestId ??
    resolveRequestId(
      event.headers?.[REQUEST_ID_HEADER.toLowerCase()],
      event.headers?.[LEGACY_REQUEST_ID_HEADER.toLowerCase()]
    );
  logger.updateMetadata({ requestId });

  try {
    // 1. Connect to database
    if (mongoose.connection.readyState !== 1) {
      await connectDB(Config.MONGODB_URI.replace('%STAGE%', Config.STAGE), logger);
    }

    // 2. Parse request body
    let body: any;
    try {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } catch (error) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
        body: JSON.stringify({ error: 'Invalid request body', request_id: requestId }),
      };
    }

    // 3. Verify JWT token
    const token = event.headers?.authorization?.replace('Bearer ', '');
    let user;
    try {
      user = await verifyJwtToken(token);
    } catch (error) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
        body: JSON.stringify({
          error: error instanceof Error ? error.message : 'Authentication failed',
          request_id: requestId,
        }),
      };
    }

    // 4. Check rate limit
    try {
      await checkRateLimit(user.id);
    } catch (error) {
      return {
        statusCode: 429,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
        body: JSON.stringify({
          error: error instanceof Error ? error.message : 'Rate limit exceeded',
          request_id: requestId,
        }),
      };
    }

    // 5. Validate request using shared logic
    const validation = validateToolRequest(body);
    if (!validation.valid) {
      return {
        statusCode: validation.statusCode,
        headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
        body: JSON.stringify({ error: validation.error, request_id: requestId }),
      };
    }

    // 6. Execute tool using shared logic
    const result = await executeToolWithLogging(validation.data, {
      userId: user.id,
      userEmail: user.email || undefined,
      logger: {
        info: msg => logger.info(`[CLI_TOOLS] ${msg}`),
        error: (msg, err) => logger.error(`[CLI_TOOLS] ${msg}`, err),
      },
    });

    // 7. Echo request_id in the body so it matches the X-Request-ID header
    // on the result path too (header/body parity).
    return {
      statusCode: result.success ? 200 : 500,
      headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
      body: JSON.stringify({ ...result, request_id: requestId }),
    };
  } catch (error) {
    logger.error('[CLI_TOOLS] Unexpected error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', [REQUEST_ID_HEADER]: requestId },
      body: JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
        request_id: requestId,
      }),
    };
  }
}

// Export as 'handler' for Lambda (SST expects this name)
export const handler = handleToolRequest;
