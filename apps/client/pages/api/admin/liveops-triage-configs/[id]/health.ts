/**
 * LiveOps Triage Config - Health Check API
 *
 * GET - Check health of a specific config with comprehensive checks:
 * 1. Issue Tracker Connection (GitHub/Jira)
 * 2. Repository/Project Access
 * 3. Slack Bot Token (with channel validation)
 * 4. LLM API Key
 * 5. Configuration Status
 */

import { getSettingsByNames } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import {
  liveopsTriageConfigRepository,
  slackDevWorkspaceRepository,
  apiKeyRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';
import { decryptToken } from '@server/security/tokenEncryption';
import { Types } from 'mongoose';
import { GitHubService } from '@server/services/githubService';
import { SlackClient } from '@bike4mind/slack';
import { apiKeyService } from '@bike4mind/services';
import { sanitizeErrorMessage, REQUIRED_GITHUB_LABELS } from '@server/services/liveopsTriageService';
import { JiraIssueTracker } from '@server/services/issueTrackers/jiraIssueTracker';

const logger = new Logger({ metadata: { service: 'liveops-config-health' } });

/**
 * Health check result
 */
interface HealthCheckResult {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{
    name: string;
    status: 'ok' | 'warning' | 'error';
    message: string;
    details?: Record<string, unknown>;
  }>;
  timestamp: string;
}

/**
 * Validate ObjectId format
 */
function isValidObjectId(id: string): boolean {
  return Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;
}

const handler = baseApi().get(async (req, res) => {
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

    // Fetch config
    const config = await liveopsTriageConfigRepository.findById(id);
    if (!config) {
      throw new NotFoundError('Config not found');
    }

    const checks: HealthCheckResult['checks'] = [];

    // Check 1: Issue Tracker Connection (GitHub or Jira)
    if (config.issueTracker === 'github') {
      // GitHub Connection Check
      try {
        const githubService = await GitHubService.forSystem(logger);
        if (!githubService) {
          checks.push({
            name: 'GitHub Connection',
            status: 'error',
            message: 'No system GitHub connection configured. Configure via Admin → GitHub Connection.',
          });
          // Always show Repository Access check (can't check without connection)
          checks.push({
            name: 'Repository Access',
            status: 'error',
            message: 'Cannot check - GitHub connection not configured',
          });
        } else {
          const result = await githubService.testConnection();
          if (result.success) {
            checks.push({
              name: 'GitHub Connection',
              status: 'ok',
              message: `Connected as ${result.login} (${result.type}) for ${config.githubOwner}/${config.githubRepo}`,
            });
          } else {
            checks.push({
              name: 'GitHub Connection',
              status: 'error',
              message: sanitizeErrorMessage(result.error || 'Connection test failed'),
            });
          }

          // Check 1b: Repository Access
          try {
            const repoFullName = `${config.githubOwner}/${config.githubRepo}`;
            const labels = await githubService.listLabels(repoFullName);

            if (labels.length === 0) {
              const repoInfo = await githubService.getRepository(repoFullName);
              if (!repoInfo) {
                checks.push({
                  name: 'Repository Access',
                  status: 'error',
                  message: `Cannot access ${repoFullName} - add it to the GitHub connection's Allowed Repositories list`,
                });
              } else {
                checks.push({
                  name: 'Repository Access',
                  status: 'warning',
                  message: `${repoFullName} accessible but has no labels. Required labels will be created automatically.`,
                });
              }
            } else {
              // Case-insensitive label comparison (GitHub labels are case-insensitive)
              const labelNamesLower = labels.map(l => l.name.toLowerCase());
              const missingLabelDefs = REQUIRED_GITHUB_LABELS.filter(
                l => !labelNamesLower.includes(l.name.toLowerCase())
              );

              if (missingLabelDefs.length > 0) {
                // Auto-create missing labels
                const created: string[] = [];
                const failed: string[] = [];

                for (const labelDef of missingLabelDefs) {
                  const result = await githubService.ensureLabelExists(repoFullName, {
                    name: labelDef.name,
                    color: labelDef.color,
                    description: labelDef.description,
                  });
                  if (result) {
                    created.push(labelDef.name);
                  } else {
                    failed.push(labelDef.name);
                  }
                }

                if (failed.length > 0) {
                  checks.push({
                    name: 'Repository Access',
                    status: 'warning',
                    message: `${repoFullName} accessible. Created labels: ${created.join(', ') || 'none'}. Failed to create: ${failed.join(', ')}`,
                  });
                } else {
                  checks.push({
                    name: 'Repository Access',
                    status: 'ok',
                    message: `${repoFullName} accessible with all required labels${created.length > 0 ? ` (created: ${created.join(', ')})` : ''}`,
                  });
                }
              } else {
                checks.push({
                  name: 'Repository Access',
                  status: 'ok',
                  message: `${repoFullName} accessible with all required labels`,
                });
              }
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            checks.push({
              name: 'Repository Access',
              status: 'error',
              message: `Repository access check failed: ${sanitizeErrorMessage(errorMsg)}`,
            });
          }
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        checks.push({
          name: 'GitHub Connection',
          status: 'error',
          message: `Failed to initialize GitHub service - ${sanitizeErrorMessage(errorMsg)}`,
        });
        // Always show Repository Access check (can't check without connection)
        checks.push({
          name: 'Repository Access',
          status: 'error',
          message: 'Cannot check - GitHub initialization failed',
        });
      }
    } else {
      // Jira Connection Check
      try {
        const jiraTracker = new JiraIssueTracker(config.jiraProjectKey || '', config.jiraIssueType || 'Bug', logger);
        const healthResult = await jiraTracker.checkHealth();

        if (healthResult.healthy) {
          checks.push({
            name: 'Jira Connection',
            status: 'ok',
            message: `Connected to Jira for project ${config.jiraProjectKey}`,
            details: { projectKey: config.jiraProjectKey, issueType: config.jiraIssueType },
          });
          checks.push({
            name: 'Project Access',
            status: 'ok',
            message: `Project ${config.jiraProjectKey} accessible with issue type "${config.jiraIssueType}"`,
            details: healthResult.details,
          });
        } else {
          // Connection worked but project/issue type has issues
          const details = healthResult.details as Record<string, unknown> | undefined;
          const connectionValid = details?.connectionValid === true;
          const projectAccessible = details?.projectAccessible === true;

          checks.push({
            name: 'Jira Connection',
            status: connectionValid ? 'ok' : 'error',
            message: connectionValid
              ? `Connected to Jira`
              : sanitizeErrorMessage(healthResult.error || 'Jira connection failed'),
            details: { projectKey: config.jiraProjectKey },
          });
          checks.push({
            name: 'Project Access',
            status: projectAccessible ? 'warning' : 'error',
            message: sanitizeErrorMessage(healthResult.error || 'Project access check failed'),
            details: { projectKey: config.jiraProjectKey, issueType: config.jiraIssueType },
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        checks.push({
          name: 'Jira Connection',
          status: 'error',
          message: `Failed to initialize Jira: ${sanitizeErrorMessage(errorMsg)}`,
        });
        checks.push({
          name: 'Project Access',
          status: 'error',
          message: 'Cannot check - Jira initialization failed',
        });
      }
    }

    // Check 2: Slack Bot Token (with channel validation)
    try {
      let slackBotToken: string | null = null;

      if (config.slackWorkspaceId) {
        const workspace = await slackDevWorkspaceRepository.findByIdWithToken(String(config.slackWorkspaceId));
        if (workspace) {
          slackBotToken = decryptToken(workspace.slackBotToken) ?? null;
        }
      } else {
        // Fallback to first active workspace
        const activeWorkspaces = await slackDevWorkspaceRepository.findAllActive();
        if (activeWorkspaces.length > 0 && activeWorkspaces[0].slackTeamId) {
          const workspaceWithToken = await slackDevWorkspaceRepository.findBySlackTeamIdWithToken(
            activeWorkspaces[0].slackTeamId
          );
          slackBotToken = decryptToken(workspaceWithToken?.slackBotToken) ?? null;
        }
      }

      if (!slackBotToken) {
        checks.push({
          name: 'Slack Bot Token',
          status: 'error',
          message: 'No active Slack workspace found. Configure via Admin → Slack Workspaces.',
        });
      } else {
        // Validate by testing auth for both source and output channels
        try {
          const testClient = new SlackClient(slackBotToken, logger);
          const channelsToCheck: Array<{ id: string; name: string }> = [{ id: config.slackChannelId, name: 'source' }];

          // Add output channel if different from source
          if (config.slackOutputChannelId && config.slackOutputChannelId !== config.slackChannelId) {
            channelsToCheck.push({ id: config.slackOutputChannelId, name: 'output' });
          }

          // Validate access to all channels
          const accessResults: string[] = [];
          for (const channel of channelsToCheck) {
            await testClient.fetchChannelHistory(channel.id, 1);
            accessResults.push(`${channel.name}: ${channel.id}`);
          }

          checks.push({
            name: 'Slack Bot Token',
            status: 'ok',
            message: `Configured and valid, can access channels (${accessResults.join(', ')})`,
          });
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          checks.push({
            name: 'Slack Bot Token',
            status: 'error',
            message: `Configured but error: ${sanitizeErrorMessage(errorMsg)}`,
          });
        }
      }
    } catch (error) {
      logger.error('[HEALTH-CHECK] Slack check failed', { error });
      checks.push({
        name: 'Slack Bot Token',
        status: 'error',
        message: 'Failed to check Slack connectivity',
      });
    }

    // Check 3: LLM API Key
    try {
      const dbAdapters = {
        db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
        getSettingsByNames,
      };
      const coreKeys = await apiKeyService.getEffectiveLLMApiKeys('system', dbAdapters);

      // Check if the configured model's API key is available
      const hasOpenAI = !!coreKeys.openai;
      const hasAnthropic = !!coreKeys.anthropic;
      const hasGemini = !!coreKeys.gemini;

      const modelId = config.modelId.toLowerCase();
      let modelKeyAvailable = false;
      let keyProvider = '';

      if (modelId.includes('gpt') || modelId.includes('o1')) {
        modelKeyAvailable = hasOpenAI;
        keyProvider = 'OpenAI';
      } else if (modelId.includes('claude')) {
        modelKeyAvailable = hasAnthropic;
        keyProvider = 'Anthropic';
      } else if (modelId.includes('gemini')) {
        modelKeyAvailable = hasGemini;
        keyProvider = 'Gemini';
      } else {
        // Default check
        modelKeyAvailable = hasOpenAI || hasAnthropic || hasGemini;
        keyProvider = 'Any';
      }

      if (modelKeyAvailable) {
        checks.push({
          name: 'LLM API Key',
          status: 'ok',
          message: `${keyProvider} API key configured for model ${config.modelId}`,
          details: { availableProviders: { openai: hasOpenAI, anthropic: hasAnthropic, gemini: hasGemini } },
        });
      } else {
        checks.push({
          name: 'LLM API Key',
          status: 'error',
          message: `No API key for ${keyProvider} (needed for ${config.modelId})`,
          details: { availableProviders: { openai: hasOpenAI, anthropic: hasAnthropic, gemini: hasGemini } },
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      checks.push({
        name: 'LLM API Key',
        status: 'error',
        message: `Error checking API keys: ${sanitizeErrorMessage(errorMsg)}`,
      });
    }

    // Check 4: Configuration Status
    try {
      let configStatus: 'ok' | 'warning' | 'error' = 'ok';
      let configMessage = 'Enabled and configured';

      if (!config.enabled) {
        configStatus = 'warning';
        configMessage = 'Configuration is disabled';
      }

      if (config.consecutiveFailures >= 3) {
        configStatus = 'warning';
        configMessage = `High failure count (${config.consecutiveFailures} consecutive failures)`;
      }

      if (config.consecutiveFailures >= 5) {
        configStatus = 'error';
        configMessage = `Circuit breaker threshold reached (${config.consecutiveFailures} consecutive failures)`;
      }

      checks.push({
        name: 'Configuration',
        status: configStatus,
        message: configMessage,
        details: {
          enabled: config.enabled,
          autoCreateIssues: config.autoCreateIssues,
          runIntervalHours: config.runIntervalHours,
          consecutiveFailures: config.consecutiveFailures,
          slackChannelId: config.slackChannelId,
          modelId: config.modelId,
        },
      });
    } catch (error) {
      checks.push({
        name: 'Configuration',
        status: 'error',
        message: 'Error checking configuration',
      });
    }

    // Determine overall status
    const hasError = checks.some(c => c.status === 'error');
    const hasWarning = checks.some(c => c.status === 'warning');
    const overall = hasError ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy';

    const result: HealthCheckResult = {
      overall,
      checks,
      timestamp: new Date().toISOString(),
    };

    return res.json(result);
  } catch (error) {
    console.error('[LIVEOPS-CONFIG-API] Error checking health:', error);
    if (error instanceof NotFoundError) {
      return res.status(404).json({ error: error.message });
    }
    if (error instanceof BadRequestError) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Failed to check health' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
