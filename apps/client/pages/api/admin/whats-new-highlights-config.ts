import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { AdminSettings } from '@bike4mind/database';
import { ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { validateHighlightsTemplate } from '@server/queueHandlers/whatsNewHighlights.prompt';

// Rate limiting constants
const ADMIN_CONFIG_RATE_LIMIT = 10; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

const SETTING_NAME = 'whatsNewHighlightsConfig';

// Slack ID validation patterns
// Channel IDs start with C (public) or D (DM) followed by alphanumeric
const SLACK_CHANNEL_ID_REGEX = /^[CD][A-Z0-9]{8,}$/;
// Team IDs start with T followed by alphanumeric
const SLACK_TEAM_ID_REGEX = /^T[A-Z0-9]{8,}$/;

// Prompt template max length (10KB should be plenty for a prompt)
const MAX_PROMPT_LENGTH = 10000;

// Schema for highlights configuration
const HighlightsConfigSchema = z.object({
  enabled: z.boolean(),
  slackChannelId: z
    .string()
    .regex(SLACK_CHANNEL_ID_REGEX, 'Invalid Slack channel ID format (should start with C or D)')
    .optional()
    .or(z.literal('')),
  slackTeamId: z
    .string()
    .regex(SLACK_TEAM_ID_REGEX, 'Invalid Slack team ID format (should start with T)')
    .optional()
    .or(z.literal('')),
  llmModel: z.string().optional(),
  promptTemplate: z
    .string()
    .max(MAX_PROMPT_LENGTH, `Prompt template must be ${MAX_PROMPT_LENGTH} characters or less`)
    .optional()
    .or(z.literal('')),
  attachMarkdownFile: z.boolean().optional(),
});

const handler = baseApi()
  .use(rateLimit({ limit: ADMIN_CONFIG_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    try {
      const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });
      const config = setting?.settingValue || {
        enabled: false,
        slackChannelId: null,
        slackTeamId: null,
        llmModel: null,
        promptTemplate: null,
        attachMarkdownFile: true,
        lastRunAt: null,
        lastStatus: null,
        lastHighlights: null,
      };

      return res.json(config);
    } catch (error) {
      console.error('Error getting highlights config:', error);
      return res.status(500).json({
        error: 'Failed to get highlights configuration',
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
      const config = HighlightsConfigSchema.parse(req.body);

      // Validate custom prompt template for security (injection patterns, invalid variables)
      if (config.promptTemplate && config.promptTemplate.trim().length > 0) {
        const templateValidation = validateHighlightsTemplate(config.promptTemplate);
        if (!templateValidation.isValid) {
          return res.status(400).json({
            error: 'Invalid prompt template',
            details: templateValidation.errors,
          });
        }
      }

      // Validate that Slack channel and team are both set if enabled
      if (config.enabled && (!config.slackChannelId || !config.slackTeamId)) {
        return res.status(400).json({
          error: 'Slack channel and team must be configured when highlights are enabled',
        });
      }

      // Get existing setting to preserve other fields
      const existing = await AdminSettings.findOne({ settingName: SETTING_NAME });
      const existingValue = (existing?.settingValue as unknown as Record<string, unknown>) || {};

      // Update the configuration
      await AdminSettings.findOneAndUpdate(
        { settingName: SETTING_NAME },
        {
          $set: {
            settingValue: {
              ...existingValue,
              ...config,
              updatedAt: new Date().toISOString(),
              updatedBy: req.user.id,
            },
          },
        },
        { upsert: true }
      );

      return res.json({
        success: true,
        config,
      });
    } catch (error) {
      console.error('Error updating highlights config:', error);

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
        });
      }

      return res.status(500).json({
        error: 'Failed to update highlights configuration',
      });
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
