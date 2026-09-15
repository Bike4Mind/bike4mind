import { Logger } from '@bike4mind/observability';
import { executeToolContract } from '@bike4mind/common';
import { checkRateLimit } from './auth';
import { executeToolWithLogging } from './toolsHandler.shared';
import { defineLambdaRoute } from './defineLambdaRoute';

/**
 * Lambda handler for CLI server-side tool execution (production & preview).
 *
 * Contract-driven (executeToolContract): defineLambdaRoute owns request parsing,
 * DB connect, JWT-only auth, the rate limit (via the `rateLimit` option, ordered
 * before validation), and contract validation (a bad body is now a 422, uniform
 * with the rest of the API - it used to be a 400). This handler owns only tool
 * execution. Local dev uses the Next.js route instead:
 * @see apps/client/pages/api/ai/v1/tools.ts
 *
 * All business logic must stay in toolsHandler.shared.ts - this and the Next.js
 * route are thin wrappers only.
 */
export const handleToolRequest = defineLambdaRoute(
  executeToolContract,
  async ({ validated, auth, requestId }) => {
    // executeToolContract is jwtOnly, so auth is always the JWT result.
    const userEmail = auth?.method === 'jwt' ? (auth.user.email ?? undefined) : undefined;

    const logger = new Logger();
    logger.updateMetadata({ requestId });

    const result = await executeToolWithLogging(validated, {
      userId: auth!.userId,
      userEmail,
      logger: {
        info: msg => logger.info(`[CLI_TOOLS] ${msg}`),
        error: (msg, err) => logger.error(`[CLI_TOOLS] ${msg}`, err),
      },
    });

    // Echo request_id in the body so it matches the X-Request-ID header on the
    // result path too (header/body parity).
    return { statusCode: result.success ? 200 : 500, body: { ...result, request_id: requestId } };
  },
  // Per-user rate limit (100/hour for the api surface). Runs before validation so a
  // flood of malformed bodies still counts against the limit (429 on exceed).
  { rateLimit: ({ auth }) => checkRateLimit(auth!.userId) }
);

// Export as 'handler' for Lambda (SST expects this name)
export const handler = handleToolRequest;
