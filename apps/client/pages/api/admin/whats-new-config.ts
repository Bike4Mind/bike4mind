import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { WhatsNewConfigService } from '@client/services/whatsNewConfigService';
import { ForbiddenError } from '@server/utils/errors';
import { WhatsNewConfigSchema } from '@bike4mind/common';
import { validateTemplate } from '@server/queueHandlers/whatsNewGeneration.templateUtils';

// Rate limiting constants
const ADMIN_CONFIG_RATE_LIMIT = 10; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

const handler = baseApi()
  .use(rateLimit({ limit: ADMIN_CONFIG_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const config = await WhatsNewConfigService.getConfig();
      return res.json(config);
    } catch (error) {
      console.error("Error getting What's New config:", error);
      return res.status(500).json({
        error: "Failed to get What's New configuration",
      });
    }
  })
  .put(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      // Validate configuration with Zod schema
      const config = WhatsNewConfigSchema.parse(req.body);

      // Validate custom template if provided
      if (config.promptTemplate) {
        const validation = validateTemplate(config.promptTemplate);
        if (!validation.isValid) {
          return res.status(400).json({
            error: 'Invalid prompt template',
            details: validation.errors,
            validationErrors: validation.errors,
          });
        }
      }

      // Update the configuration with history tracking
      await WhatsNewConfigService.updateConfigWithHistory(config, req.user.id, req.user.username ?? req.user.email);

      return res.json({
        success: true,
        config,
      });
    } catch (error) {
      console.error("Error updating What's New config:", error);

      // Check if it's a Zod validation error
      if (error && typeof error === 'object' && 'issues' in error) {
        const zodError = error as { issues: Array<{ path: (string | number)[]; message: string }> };
        const validationErrors = zodError.issues.map(issue => {
          const field = issue.path.join('.');
          return field ? `${field}: ${issue.message}` : issue.message;
        });

        return res.status(400).json({
          error: 'Invalid configuration',
          details: validationErrors,
          validationErrors: validationErrors,
        });
      }

      // Check if it's a generic Error
      if (error instanceof Error) {
        return res.status(400).json({
          error: 'Invalid configuration',
          details: [error.message],
        });
      }

      return res.status(500).json({
        error: "Failed to update What's New configuration",
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
