import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError } from '@server/utils/errors';
import { adminSettingsRepository, slackDevWorkspaceRepository } from '@bike4mind/database';
import { GitHubService } from '@server/services/githubService';
import { ContextTelemetryAlertsSchema, CHAT_MODELS } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

interface HealthCheckItem {
  name: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const logger = new Logger({ metadata: { service: 'ContextTelemetryHealthCheck' } });
    const checks: HealthCheckItem[] = [];

    const alertSettingsRaw = await adminSettingsRepository.getSettingsValue('contextTelemetryAlerts');
    const alertSettings = ContextTelemetryAlertsSchema.safeParse(alertSettingsRaw);
    const config = alertSettings.success ? alertSettings.data : null;

    // Check GitHub integration via system default connection (like LiveOps Triage)
    let githubConfigured = false;
    let githubRepoConfigured = false;

    try {
      const githubService = await GitHubService.forSystem(logger);
      if (githubService) {
        const testResult = await githubService.testConnection();
        if (testResult.success) {
          githubConfigured = true;
          if (config?.githubOwner && config?.githubRepo) {
            githubRepoConfigured = true;
            checks.push({
              name: 'GitHub',
              status: 'ok',
              message: `Connected → ${config.githubOwner}/${config.githubRepo}`,
            });
          } else {
            checks.push({
              name: 'GitHub',
              status: 'warning',
              message: 'Connected but repository not configured',
            });
          }
        } else {
          checks.push({
            name: 'GitHub',
            status: 'error',
            message: testResult.error || 'Connection test failed',
          });
        }
      } else {
        checks.push({
          name: 'GitHub',
          status: 'error',
          message: 'No system GitHub connection configured',
        });
      }
    } catch (error) {
      logger.warn('[ContextTelemetry] GitHub check failed:', error);
      checks.push({
        name: 'GitHub',
        status: 'error',
        message: 'Failed to check GitHub connection',
      });
    }

    // Check Slack integration via workspace (OAuth-based like LiveOps Triage)
    let slackConfigured = false;

    if (config?.slackWorkspaceId) {
      try {
        const workspace = await slackDevWorkspaceRepository.findByIdWithToken(config.slackWorkspaceId);
        if (workspace && workspace.slackBotToken) {
          slackConfigured = true;
          if (config.slackChannelId) {
            if (config.enabled) {
              checks.push({
                name: 'Slack Alerts',
                status: 'ok',
                message: `${workspace.name} → Alerts enabled`,
              });
            } else {
              checks.push({
                name: 'Slack Alerts',
                status: 'warning',
                message: `${workspace.name} → Alerts disabled`,
              });
            }
          } else {
            checks.push({
              name: 'Slack Alerts',
              status: 'warning',
              message: `${workspace.name} → Channel not selected`,
            });
          }
        } else {
          checks.push({
            name: 'Slack Alerts',
            status: 'error',
            message: 'Configured workspace not found or token expired',
          });
        }
      } catch (error) {
        logger.warn('[ContextTelemetry] Slack check failed:', error);
        checks.push({
          name: 'Slack Alerts',
          status: 'error',
          message: 'Failed to check Slack workspace',
        });
      }
    } else {
      try {
        const workspaces = await slackDevWorkspaceRepository.findAllActive();
        if (workspaces.length > 0) {
          checks.push({
            name: 'Slack Alerts',
            status: 'warning',
            message: `${workspaces.length} workspace(s) available → Select one`,
          });
        } else {
          checks.push({
            name: 'Slack Alerts',
            status: 'error',
            message: 'No Slack workspaces connected',
          });
        }
      } catch {
        checks.push({
          name: 'Slack Alerts',
          status: 'error',
          message: 'No Slack workspace configured',
        });
      }
    }

    if (config?.modelId) {
      const isValidModel = (CHAT_MODELS as readonly string[]).includes(config.modelId);
      if (isValidModel) {
        checks.push({
          name: 'LLM Analysis',
          status: 'ok',
          message: `Model: ${config.modelId}`,
        });
      } else {
        checks.push({
          name: 'LLM Analysis',
          status: 'warning',
          message: `Unknown model: ${config.modelId}`,
        });
      }
    } else {
      checks.push({
        name: 'LLM Analysis',
        status: 'warning',
        message: 'No model configured → Select a model',
      });
    }

    const hasError = checks.some(c => c.status === 'error');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overall = hasError ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy';

    res.json({
      overall,
      checks,
      // Detailed status for UI components
      github: githubConfigured && githubRepoConfigured,
      slack: slackConfigured && config?.enabled && Boolean(config?.slackChannelId),
      llm: Boolean(config?.modelId),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
