/**
 * LiveOps Triage Config Admin API - Single Config Operations
 *
 * GET - Get single config by ID
 * PUT - Update config
 * DELETE - Delete config
 */

import {
  liveopsTriageConfigRepository,
  liveopsTriageRunRepository,
  liveopsTriageConfigAuditLogRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';
import { z } from 'zod';
import { Types } from 'mongoose';
import { validateTemplate } from '@server/services/liveopsTriagePrompt';
import type { ILiveopsTriageConfigFieldChange } from '@bike4mind/database/infra';

/**
 * Schema for updating a config
 */
const UpdateConfigSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),

  // Slack settings
  slackWorkspaceId: z.string().nullable().optional(),
  slackChannelId: z
    .string()
    .min(1)
    .regex(/^C[A-Z0-9]+$/, 'Invalid Slack channel ID format')
    .optional(),
  slackOutputChannelId: z
    .string()
    .regex(/^C[A-Z0-9]+$/, 'Invalid Slack channel ID format')
    .nullable()
    .optional(),

  // Issue tracker
  issueTracker: z.enum(['github', 'jira']).optional(),

  // GitHub settings
  githubOwner: z.string().nullable().optional(),
  githubRepo: z.string().nullable().optional(),

  // Jira settings
  jiraProjectKey: z
    .string()
    .regex(/^[A-Z][A-Z0-9]*$/, 'Invalid Jira project key format')
    .nullable()
    .optional(),
  jiraIssueType: z.string().nullable().optional(),

  // Schedule
  runIntervalHours: z.union([z.literal(6), z.literal(12), z.literal(24)]).optional(),

  // LLM settings
  modelId: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().min(100).max(16000).optional(),
  timeoutMs: z.number().min(5000).max(300000).optional(),
  promptTemplate: z.string().nullable().optional(),

  // Behavior settings
  maxErrorsPerRun: z.number().min(1).max(200).optional(),
  regressionLookbackDays: z.number().min(1).max(180).optional(),
  regressionGracePeriodHours: z.number().min(1).max(168).optional(),
  autoCreateIssues: z.boolean().optional(),
  postWhenNoErrors: z.boolean().optional(),
});

/**
 * Validate ObjectId format
 */
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

const handler = baseApi()
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Config ID is required');
      }

      if (!isValidObjectId(id)) {
        throw new BadRequestError('Invalid config ID format');
      }

      const config = await liveopsTriageConfigRepository.findById(id);

      if (!config) {
        throw new NotFoundError('Config not found');
      }

      return res.json(config);
    } catch (error) {
      console.error('[LIVEOPS-CONFIG-API] Error fetching config:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to fetch config' });
    }
  })
  .put(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Config ID is required');
      }

      if (!isValidObjectId(id)) {
        throw new BadRequestError('Invalid config ID format');
      }

      // Validate request body
      const parseResult = UpdateConfigSchema.safeParse(req.body);
      if (!parseResult.success) {
        const errors = parseResult.error.flatten();
        return res.status(422).json({
          error: 'Validation failed',
          code: 'VALIDATION_FAILED',
          validationErrors: errors.fieldErrors,
        });
      }

      const data = parseResult.data;

      // Validate custom prompt template if provided
      if (data.promptTemplate) {
        const templateValidation = validateTemplate(data.promptTemplate);
        if (!templateValidation.isValid) {
          return res.status(400).json({
            error: 'Invalid prompt template',
            code: 'INVALID_TEMPLATE',
            validationErrors: templateValidation.errors,
          });
        }
      }

      // Check unique name if name is being changed
      if (data.name) {
        const isUnique = await liveopsTriageConfigRepository.isNameUnique(data.name, id);
        if (!isUnique) {
          return res.status(409).json({
            error: 'A config with this name already exists',
            code: 'DUPLICATE_NAME',
          });
        }
      }

      // Fetch existing config to validate issue tracker-specific fields
      const existingConfig = await liveopsTriageConfigRepository.findById(id);
      if (!existingConfig) {
        throw new NotFoundError('Config not found');
      }

      // Determine the effective issue tracker
      const effectiveIssueTracker = data.issueTracker ?? existingConfig.issueTracker;

      // Validate issue tracker-specific fields
      const effectiveGithubOwner = data.githubOwner ?? existingConfig.githubOwner;
      const effectiveGithubRepo = data.githubRepo ?? existingConfig.githubRepo;
      const effectiveJiraProjectKey = data.jiraProjectKey ?? existingConfig.jiraProjectKey;

      if (effectiveIssueTracker === 'github') {
        if (!effectiveGithubOwner || !effectiveGithubRepo) {
          throw new BadRequestError('GitHub owner and repo are required for GitHub issue tracker');
        }
      } else if (effectiveIssueTracker === 'jira') {
        if (!effectiveJiraProjectKey) {
          throw new BadRequestError('Jira project key is required for Jira issue tracker');
        }
      }

      // Update the config
      const updatedConfig = await liveopsTriageConfigRepository.updateConfig(id, data);

      if (!updatedConfig) {
        throw new NotFoundError('Config not found');
      }

      // Audit log for SOC2 compliance - track changes
      const changes: Record<string, ILiveopsTriageConfigFieldChange> = {};
      for (const key of Object.keys(data) as Array<keyof typeof data>) {
        const oldValue = existingConfig[key as keyof typeof existingConfig];
        const newValue = data[key];
        if (oldValue !== newValue && newValue !== undefined) {
          changes[key] = { old: oldValue, new: newValue };
        }
      }

      // Determine action type - special handling for enable/disable
      let action: 'update' | 'enable' | 'disable' = 'update';
      if (data.enabled !== undefined && data.enabled !== existingConfig.enabled) {
        action = data.enabled ? 'enable' : 'disable';
      }

      await liveopsTriageConfigAuditLogRepository.createLog({
        configId: id,
        configName: updatedConfig.name,
        action,
        userId: req.user.id,
        userName: req.user.username ?? req.user.email ?? 'Unknown',
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      });

      return res.json(updatedConfig);
    } catch (error) {
      console.error('[LIVEOPS-CONFIG-API] Error updating config:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to update config' });
    }
  })
  .delete(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Config ID is required');
      }

      if (!isValidObjectId(id)) {
        throw new BadRequestError('Invalid config ID format');
      }

      // Fetch config before deletion for audit log
      const configToDelete = await liveopsTriageConfigRepository.findById(id);
      if (!configToDelete) {
        throw new NotFoundError('Config not found');
      }

      // Check for active runs
      const hasActiveRuns = await liveopsTriageRunRepository.hasActiveRunForConfig(id);
      if (hasActiveRuns) {
        return res.status(409).json({
          error: 'Cannot delete config with active runs',
          code: 'ACTIVE_RUNS_EXIST',
        });
      }

      const deleted = await liveopsTriageConfigRepository.deleteConfig(id);

      if (!deleted) {
        throw new NotFoundError('Config not found');
      }

      // Audit log for SOC2 compliance
      await liveopsTriageConfigAuditLogRepository.createLog({
        configId: id,
        configName: configToDelete.name,
        action: 'delete',
        userId: req.user.id,
        userName: req.user.username ?? req.user.email ?? 'Unknown',
      });

      return res.json({ success: true, message: 'Config deleted successfully' });
    } catch (error) {
      console.error('[LIVEOPS-CONFIG-API] Error deleting config:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to delete config' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
