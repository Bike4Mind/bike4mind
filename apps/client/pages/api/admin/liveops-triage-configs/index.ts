/**
 * LiveOps Triage Configs Admin API
 *
 * GET - List all configs
 * POST - Create new config
 */

import { liveopsTriageConfigRepository, liveopsTriageConfigAuditLogRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';

/**
 * Schema for creating a new config
 */
const CreateConfigSchema = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(false),

  // Slack settings
  slackWorkspaceId: z.string().optional(),
  slackChannelId: z
    .string()
    .min(1)
    .regex(/^C[A-Z0-9]+$/, 'Invalid Slack channel ID format'),
  slackOutputChannelId: z
    .string()
    .regex(/^C[A-Z0-9]+$/, 'Invalid Slack channel ID format')
    .optional(),

  // Issue tracker
  issueTracker: z.enum(['github', 'jira']),

  // GitHub settings
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),

  // Jira settings
  jiraProjectKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*$/, 'Invalid Jira project key format')
    .optional(),
  jiraIssueType: z.string().optional().default('Bug'),

  // Schedule
  runIntervalHours: z
    .union([z.literal(6), z.literal(12), z.literal(24)])
    .optional()
    .default(12),

  // LLM settings
  modelId: z.string().min(1),
  temperature: z.number().min(0).max(2).optional().default(0.3),
  maxTokens: z.number().min(100).max(16000).optional().default(1000),
  timeoutMs: z.number().min(5000).max(300000).optional().default(60000),
  promptTemplate: z.string().optional(),

  // Behavior settings
  maxErrorsPerRun: z.number().min(1).max(200).optional().default(50),
  regressionLookbackDays: z.number().min(1).max(180).optional().default(30),
  regressionGracePeriodHours: z.number().min(1).max(168).optional().default(48),
  autoCreateIssues: z.boolean().optional().default(false),
  postWhenNoErrors: z.boolean().optional().default(true),
});

const handler = baseApi()
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const configs = await liveopsTriageConfigRepository.findAll();
      return res.json(configs);
    } catch (error) {
      console.error('[LIVEOPS-CONFIG-API] Error fetching configs:', error);
      return res.status(500).json({ error: 'Failed to fetch configs' });
    }
  })
  .post(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      // Validate request body
      const parseResult = CreateConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        const errors = parseResult.error.flatten();
        return res.status(400).json({
          error: 'Validation failed',
          code: 'VALIDATION_FAILED',
          validationErrors: errors.fieldErrors,
        });
      }

      const data = parseResult.data;

      // Check unique name
      const isUnique = await liveopsTriageConfigRepository.isNameUnique(data.name);
      if (!isUnique) {
        return res.status(409).json({
          error: 'A config with this name already exists',
          code: 'DUPLICATE_NAME',
        });
      }

      // Validate issue tracker-specific fields
      if (data.issueTracker === 'github') {
        if (!data.githubOwner || !data.githubRepo) {
          throw new BadRequestError('GitHub owner and repo are required for GitHub issue tracker');
        }
      } else if (data.issueTracker === 'jira') {
        if (!data.jiraProjectKey) {
          throw new BadRequestError('Jira project key is required for Jira issue tracker');
        }
      }

      // Create the config
      const newConfig = await liveopsTriageConfigRepository.createConfig(data);

      // Audit log for SOC2 compliance
      await liveopsTriageConfigAuditLogRepository.createLog({
        configId: newConfig.id,
        configName: newConfig.name,
        action: 'create',
        userId: req.user.id,
        userName: req.user.username ?? req.user.email ?? 'Unknown',
      });

      return res.status(201).json(newConfig);
    } catch (error) {
      console.error('[LIVEOPS-CONFIG-API] Error creating config:', error);
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to create config' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
