import { Logger } from '@bike4mind/observability';
import { executeToolContract } from '@bike4mind/common';
import { checkRateLimit } from './auth';
import { executeToolWithLogging } from './toolsHandler.shared';
import { defineLambdaRoute } from './defineLambdaRoute';

/**
 * Lambda handler for CLI server-side tool execution (production & preview).
 *
 * Contract-driven (executeToolContract): defineLambdaRoute owns request parsing,
 * DB connect, JWT-only auth, and contract validation (a bad body is now a 422,
 * uniform with the rest of the API - it used to be a 400). This handler owns only
 * the rate limit and execution. Local dev uses the Next.js route instead:
 * @see apps/client/pages/api/ai/v1/tools.ts
 *
 * All business logic must stay in toolsHandler.shared.ts - this and the Next.js
 * route are thin wrappers only.
 */
export const handleToolRequest = defineLambdaRoute(executeToolContract, async ({ validated, auth, requestId }) => {
  // executeToolContract is jwtOnly, so auth is always the JWT result.
  const userId = auth!.userId;
  const userEmail = auth?.method === 'jwt' ? (auth.user.email ?? undefined) : undefined;

  // Per-user rate limit (100/hour for the api surface); 429 on exceed.
  try {
    await checkRateLimit(userId);
  } catch (error) {
    return {
      statusCode: 429,
      body: { error: error instanceof Error ? error.message : 'Rate limit exceeded', request_id: requestId },
    };
  }

  const logger = new Logger();
  logger.updateMetadata({ requestId });

  const result = await executeToolWithLogging(validated, {
    userId,
    userEmail,
    logger: {
      info: msg => logger.info(`[CLI_TOOLS] ${msg}`),
      error: (msg, err) => logger.error(`[CLI_TOOLS] ${msg}`, err),
    },
  });

  // Echo request_id in the body so it matches the X-Request-ID header on the
  // result path too (header/body parity).
  return { statusCode: result.success ? 200 : 500, body: { ...result, request_id: requestId } };
});

// Export as 'handler' for Lambda (SST expects this name)
export const handler = handleToolRequest;
