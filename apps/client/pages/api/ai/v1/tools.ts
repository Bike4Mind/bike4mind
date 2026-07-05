import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { validateToolRequest, executeToolWithLogging } from '@server/cli/toolsHandler.shared';

/**
 * Next.js API route for CLI server-side tool execution (LOCAL DEV ONLY)
 *
 * IMPORTANT: This is a THIN WRAPPER around shared business logic.
 * All validation, execution, and logging logic is in toolsHandler.shared.ts
 *
 * This handler is used in LOCAL DEVELOPMENT ONLY.
 * For production and preview environments, we use the Lambda handler:
 * @see apps/client/server/cli/tools.ts
 *
 * WHY dual implementation?
 * - SST dev + Lambda Function URLs + CloudFront router = socket hang ups
 * - Tools don't need streaming, but dev mode routing is unreliable
 * - Next.js API works reliably in local dev
 *
 * CRITICAL: All business logic is in toolsHandler.shared.ts
 * Both this file and the Lambda handler are thin wrappers only.
 * Never add business logic to either handler.
 */

const handler = baseApi()
  .use(
    rateLimit({
      limit: 100, // 100 requests per hour (matches Lambda handler)
      windowMs: 60 * 60 * 1000, // 1 hour
    })
  )
  .post(async (req, res) => {
    try {
      // 1. Validate request using shared logic
      const validation = validateToolRequest(req.body);
      if (!validation.valid) {
        return res.status(validation.statusCode).json({ error: validation.error, request_id: req.requestId });
      }

      // 2. Execute tool using shared logic
      const result = await executeToolWithLogging(validation.data, {
        userId: req.user?.id,
        userEmail: req.user?.email || undefined,
        logger: {
          info: msg => req.logger.info(`[TOOLS_API] ${msg}`),
          error: (msg, err) => req.logger.error(`[TOOLS_API] ${msg}`, err),
        },
      });

      // 3. Return result - echo request_id in the body to match the
      // X-Request-ID header set by the logging middleware.
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
