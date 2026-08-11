import { rateLimit } from '@server/middlewares/rateLimit';
import { executeToolWithLogging } from '@server/cli/toolsHandler.shared';
import { executeToolContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';

/**
 * Next.js API route for CLI server-side tool execution (LOCAL DEV ONLY).
 *
 * Contract-driven (executeToolContract): nextRouteForContract owns auth + request
 * validation (`req.validated`; a bad body is a 422, uniform with the API - it used
 * to be a 400). Business logic stays in toolsHandler.shared.ts. Production/preview
 * use the Lambda handler instead (@see apps/client/server/cli/tools.ts).
 *
 * WHY dual implementation? SST dev + Lambda Function URLs + CloudFront router =
 * socket hang ups; Next.js API works reliably in local dev.
 */
const handler = nextRouteForContract(executeToolContract, {
  // Passed as an option so the adapter orders it before validation (a malformed
  // body still counts against the limiter). 100 requests/hour (matches the Lambda).
  rateLimit: rateLimit({ limit: 100, windowMs: 60 * 60 * 1000 }),
}).post(async (req, res) => {
  try {
    const result = await executeToolWithLogging(req.validated, {
      userId: req.user?.id,
      userEmail: req.user?.email || undefined,
      logger: {
        info: msg => req.logger.info(`[TOOLS_API] ${msg}`),
        error: (msg, err) => req.logger.error(`[TOOLS_API] ${msg}`, err),
      },
    });

    // Echo request_id in the body to match the X-Request-ID header.
    return res.status(result.success ? 200 : 500).json({ ...result, request_id: req.requestId });
  } catch (error) {
    req.logger.error('[TOOLS_API] Unexpected error:', error);

    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Internal server error',
      request_id: req.requestId,
    });
  }
});

export default handler;
