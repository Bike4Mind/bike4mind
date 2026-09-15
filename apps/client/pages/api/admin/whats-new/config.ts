import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { rateLimit } from '@server/middlewares/rateLimit';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { AdminSettings } from '@bike4mind/database';
import { WhatsNewSyncConfigSchema, type WhatsNewSyncConfig } from '@bike4mind/common';
import { getWhatsNewEnvInfo } from '@server/utils/whatsNewEnv';
import { validateDistributionUrl } from '@server/services/whatsNewForkFetcher';

const SETTING_NAME = 'whatsNewSyncConfig';

export interface SyncConfigResponse {
  success: boolean;
  config: WhatsNewSyncConfig;
  stage: string;
  /** True if this is the source environment that generates modals (has ENABLE_WHATS_NEW_DISTRIBUTION=true) */
  isSourceEnvironment: boolean;
  /** True if this is a fork production environment (stage=production but not source) - defaults to auto-sync OFF */
  isForkProduction: boolean;
  /** True if distribution URL is configured (admin override or SST secret) */
  distributionUrlConfigured: boolean;
  /** Source of the distribution URL: 'admin' or 'sst' */
  distributionUrlSource?: 'admin' | 'sst';
  timestamp: string;
  error?: string;
}

/**
 * GET /api/admin/whats-new/config
 * PUT /api/admin/whats-new/config
 *
 * Get or update What's New sync configuration.
 * Only available in non-source environments (staging, dev, fork production).
 * Source environment (main production with ENABLE_WHATS_NEW_DISTRIBUTION=true) generates modals.
 * Requires admin privileges.
 *
 * PUT request body:
 * {
 *   autoSyncEnabled: boolean
 * }
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 30,
      windowMs: 60 * 1000, // 30 requests per minute
    })
  )
  .get(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const env = await getWhatsNewEnvInfo();

    // Source environment generates modals and doesn't need sync configuration
    if (env.isSourceEnvironment) {
      return res.json({
        success: true,
        config: { autoSyncEnabled: false },
        stage: env.stage,
        isSourceEnvironment: env.isSourceEnvironment,
        isForkProduction: env.isForkProduction,
        distributionUrlConfigured: env.distributionUrlConfigured,
        distributionUrlSource: env.distributionUrlSource,
        timestamp: new Date().toISOString(),
      } satisfies SyncConfigResponse);
    }

    try {
      const setting = await AdminSettings.findOne({ settingName: SETTING_NAME });

      // If no setting exists, use environment-appropriate default
      // If setting exists, use the stored value
      const config = setting?.settingValue
        ? WhatsNewSyncConfigSchema.parse(setting.settingValue)
        : { autoSyncEnabled: env.defaultAutoSyncEnabled };

      return res.json({
        success: true,
        config,
        stage: env.stage,
        isSourceEnvironment: env.isSourceEnvironment,
        isForkProduction: env.isForkProduction,
        distributionUrlConfigured: env.distributionUrlConfigured,
        distributionUrlSource: env.distributionUrlSource,
        timestamp: new Date().toISOString(),
      } satisfies SyncConfigResponse);
    } catch (error) {
      req.logger?.error("Error getting What's New sync config:", { error });
      return res.status(500).json({
        success: false,
        config: { autoSyncEnabled: env.defaultAutoSyncEnabled },
        stage: env.stage,
        isSourceEnvironment: env.isSourceEnvironment,
        isForkProduction: env.isForkProduction,
        distributionUrlConfigured: env.distributionUrlConfigured,
        distributionUrlSource: env.distributionUrlSource,
        timestamp: new Date().toISOString(),
        error: 'Failed to get sync config. Using default values.',
      } satisfies SyncConfigResponse);
    }
  })
  .put(async (req: Request, res: Response) => {
    // Check if user is admin
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const env = await getWhatsNewEnvInfo();

    // Block modifications in source environment (it generates modals, doesn't sync)
    if (env.isSourceEnvironment) {
      return res.status(403).json({
        success: false,
        config: { autoSyncEnabled: false },
        stage: env.stage,
        isSourceEnvironment: env.isSourceEnvironment,
        isForkProduction: env.isForkProduction,
        distributionUrlConfigured: env.distributionUrlConfigured,
        distributionUrlSource: env.distributionUrlSource,
        timestamp: new Date().toISOString(),
        error: 'Sync configuration cannot be modified in the source environment',
      } satisfies SyncConfigResponse);
    }

    // Validate request body
    const parseResult = WhatsNewSyncConfigSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new BadRequestError(
        `Invalid configuration: ${parseResult.error.issues.map((e: { message: string }) => e.message).join(', ')}`
      );
    }

    const newConfig = parseResult.data;

    // Validate distribution URL override against domain allowlist (SSRF prevention)
    if (newConfig.distributionUrlOverride) {
      const validation = validateDistributionUrl(newConfig.distributionUrlOverride);
      if (!validation.valid) {
        throw new BadRequestError(`Invalid distribution URL: ${validation.error}`);
      }
    }

    try {
      // Get existing config for comparison
      const existingSetting = await AdminSettings.findOne({ settingName: SETTING_NAME });
      const oldConfig = WhatsNewSyncConfigSchema.parse(existingSetting?.settingValue || {});

      // Update config
      await AdminSettings.findOneAndUpdate(
        { settingName: SETTING_NAME },
        { settingValue: newConfig },
        { upsert: true }
      );

      // Log audit event with enhanced tracking for URL changes
      await logAuditEvent(
        {
          userId: req.user!.id,
          action: AdminConfigAuditEvents.WHATS_NEW_CONFIG_UPDATED,
          ip: req.ip,
          userAgent: req.headers['user-agent'] || 'unknown',
          metadata: {
            oldConfig,
            newConfig,
            changes: {
              autoSyncEnabled: oldConfig.autoSyncEnabled !== newConfig.autoSyncEnabled,
              distributionUrlOverride: oldConfig.distributionUrlOverride !== newConfig.distributionUrlOverride,
            },
          },
        },
        req.logger
      );

      req.logger?.info("What's New sync config updated", { oldConfig, newConfig });

      // Re-fetch env info to get updated distributionUrlSource
      const updatedEnv = await getWhatsNewEnvInfo();

      return res.json({
        success: true,
        config: newConfig,
        stage: updatedEnv.stage,
        isSourceEnvironment: updatedEnv.isSourceEnvironment,
        isForkProduction: updatedEnv.isForkProduction,
        distributionUrlConfigured: updatedEnv.distributionUrlConfigured,
        distributionUrlSource: updatedEnv.distributionUrlSource,
        timestamp: new Date().toISOString(),
      } satisfies SyncConfigResponse);
    } catch (error) {
      req.logger?.error("Error updating What's New sync config:", { error });
      return res.status(500).json({
        success: false,
        config: { autoSyncEnabled: env.defaultAutoSyncEnabled },
        stage: env.stage,
        isSourceEnvironment: env.isSourceEnvironment,
        isForkProduction: env.isForkProduction,
        distributionUrlConfigured: env.distributionUrlConfigured,
        distributionUrlSource: env.distributionUrlSource,
        timestamp: new Date().toISOString(),
        error: 'Failed to update sync config. Check server logs for details.',
      } satisfies SyncConfigResponse);
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
