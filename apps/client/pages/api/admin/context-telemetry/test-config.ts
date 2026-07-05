import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { TELEMETRY_SAFE_PROJECTION } from '@server/utils/telemetryProjection';
import { telemetryDryRunResultRepository, adminSettingsRepository, Quest } from '@bike4mind/database';
import { z } from 'zod';
import { ContextTelemetryAlertsSchema, type ContextTelemetry, ALERT_THRESHOLDS } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  generateTelemetryFingerprint,
  generateSemanticTelemetryFingerprint,
  getSeverityEmoji,
  formatPrimaryAnomaly,
} from '@server/services/telemetryFingerprint';
import { checkFingerprintDedup } from '@server/services/issueDedup';
import { GitHubService } from '@server/services/githubService';
import {
  getFallbackPriority,
  fetchExistingTelemetryIssues,
  fetchRecentlyClosedIssues,
} from '@server/utils/telemetryIssueCreator';

const requestSchema = z.object({
  useSample: z.boolean().optional(),
  sampleType: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  telemetryEntryId: z.string().optional(),
});

/**
 * Generate sample telemetry data for testing
 */
function generateSampleTelemetry(severity: 'critical' | 'high' | 'medium' | 'low'): ContextTelemetry {
  const configs = {
    critical: {
      anomalyScore: 85,
      primaryAnomaly: 'context_overflow' as const,
      utilization: 105,
      responseTime: 8000,
      firstToken: 2000,
    },
    high: {
      anomalyScore: 55,
      primaryAnomaly: 'slow_response' as const,
      utilization: 92,
      responseTime: 45000,
      firstToken: 12000,
    },
    medium: {
      anomalyScore: 35,
      primaryAnomaly: 'high_truncation' as const,
      utilization: 78,
      responseTime: 8000,
      firstToken: 2000,
    },
    low: {
      anomalyScore: 15,
      primaryAnomaly: 'none' as const,
      utilization: 45,
      responseTime: 5000,
      firstToken: 1000,
    },
  };

  const config = configs[severity];

  return {
    schemaVersion: '1.0',
    timestamp: new Date().toISOString(),
    captureOverheadMs: 5,
    anonymousSessionId: {
      hash: 'sample-test-hash-' + Date.now(),
      dateKey: new Date().toISOString().slice(0, 10),
    },
    operation: {
      name: 'chat_completion',
      finishReason: 'stop',
    },
    model: {
      modelId: 'claude-3-5-sonnet-20241022',
      provider: 'anthropic',
      fallbackUsed: false,
      usedThinking: false,
      usedTools: false,
    },
    systemPrompts: {
      prompts: [
        { source: 'hardcoded', name: 'core', tokenCount: 2000, wasIncluded: true },
        { source: 'admin', name: 'custom', tokenCount: 500, wasIncluded: true },
      ],
      totalTokens: 2500,
      duplicateCount: 0,
    },
    features: {
      contributions: [],
    },
    contextWindow: {
      inputTokens: Math.floor(config.utilization * 2000),
      outputTokens: 500,
      utilizationPercentage: config.utilization,
      contextWindowLimit: 200000,
      reservedOutputTokens: 4096,
      overflowDetected: config.utilization > 100,
      overflowAmount: config.utilization > 100 ? Math.floor((config.utilization - 100) * 2000) : undefined,
      tokensBySource: {
        systemPrompts: 5000,
        conversationHistory: 80000,
        mementos: 20000,
        fabFiles: 30000,
        urlContent: 10000,
        toolSchemas: 5000,
        userPrompt: 2000,
      },
    },
    costs: {
      inputCostUsd: 0.015,
      outputCostUsd: 0.003,
      totalCostUsd: 0.018,
      creditsUsed: 18,
    },
    truncation: {
      wasTruncated: config.primaryAnomaly === 'high_truncation',
      originalMessageCount: 50,
      finalMessageCount: config.primaryAnomaly === 'high_truncation' ? 25 : 50,
      truncatedMessageCount: config.primaryAnomaly === 'high_truncation' ? 25 : 0,
      truncationMethod: config.primaryAnomaly === 'high_truncation' ? 'token-budget' : undefined,
      truncationPercentage: config.primaryAnomaly === 'high_truncation' ? 50 : 0,
    },
    performance: {
      totalResponseTimeMs: config.responseTime,
      firstTokenTimeMs: config.firstToken,
    },
    anomalies: {
      anomalyScore: config.anomalyScore,
      severity,
      primaryAnomaly: config.primaryAnomaly,
      dedupKey: `${config.primaryAnomaly}_claude-3-5-sonnet_anthropic`,
      contextOverflow: config.utilization > 100,
      criticalUtilization: config.utilization >= 95,
      highUtilization: config.utilization >= 90,
      criticalTruncation: false,
      highTruncation: config.primaryAnomaly === 'high_truncation',
      toolFailureSpike: false,
      toolTimeout: false,
      subagentTimeout: false,
      slowTotalResponse: severity === 'high',
      slowFirstToken: false,
    },
    requestMetadata: {
      queryComplexity: 'contextual',
      historyMessageCount: 50,
      attachedFileCount: 2,
      mementoCount: 5,
      enabledFeatures: ['mementos', 'fabFiles'],
    },
    tools: [],
    subagents: [],
  };
}

/**
 * POST /api/admin/context-telemetry/test-config
 *
 * Triggers a test of the telemetry alert configuration.
 * Simulates what would happen without actually creating issues or sending alerts.
 */
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const logger = new Logger({ metadata: { service: 'TelemetryTestConfig' } });

    // Parse request body
    const body = requestSchema.parse(req.body);

    // Get telemetry data (sample or from entry)
    let telemetry: ContextTelemetry;

    if (body.telemetryEntryId) {
      // No org scoping needed: admin-only endpoint (isAdmin check above) and
      // telemetry data is anonymized (no PII or org-specific content).
      const quest = await Quest.findById(body.telemetryEntryId).select(TELEMETRY_SAFE_PROJECTION).lean();

      if (!quest?.promptMeta?.contextTelemetry) {
        throw new BadRequestError('Telemetry entry not found or has no telemetry data');
      }

      telemetry = quest.promptMeta.contextTelemetry;
    } else {
      // Use sample data
      const sampleType = body.sampleType || 'high';
      telemetry = generateSampleTelemetry(sampleType);
    }

    // Get alert config
    const alertSettingsRaw = await adminSettingsRepository.getSettingsValue('contextTelemetryAlerts');
    const alertSettings = ContextTelemetryAlertsSchema.safeParse(alertSettingsRaw);
    const config = alertSettings.success ? alertSettings.data : ContextTelemetryAlertsSchema.parse({});

    // Generate fingerprints
    const fingerprint = generateTelemetryFingerprint(telemetry);
    const semanticFingerprint = generateSemanticTelemetryFingerprint(telemetry);

    // Determine priority
    const priority = getFallbackPriority(telemetry);

    // Initialize action result
    let wouldCreateIssue = false;
    let issueTitle: string | undefined;
    const labels: string[] = ['bug', 'telemetry', priority];
    let isRegression = false;
    let regressedFromIssue: number | undefined;
    let isDuplicate = false;
    let matchedIssueNumber: number | undefined;

    // Check deduplication if GitHub is configured
    if (config.autoCreateIssues && config.githubOwner && config.githubRepo) {
      const issueThreshold = config.alertThreshold ?? ALERT_THRESHOLDS.warning;

      if (telemetry.anomalies.anomalyScore >= issueThreshold) {
        try {
          const githubService = await GitHubService.forSystem(logger);

          if (githubService) {
            const repoFullName = `${config.githubOwner}/${config.githubRepo}`;
            const lookbackDays = config.regressionLookbackDays ?? 30;
            const gracePeriodHours = config.regressionGracePeriodHours ?? 48;

            // Fetch existing issues
            const [openIssues, closedIssues] = await Promise.all([
              fetchExistingTelemetryIssues(githubService, repoFullName, logger),
              fetchRecentlyClosedIssues(githubService, repoFullName, lookbackDays, logger),
            ]);

            // Check deduplication
            const dedupResult = checkFingerprintDedup(
              fingerprint,
              semanticFingerprint,
              openIssues,
              closedIssues,
              gracePeriodHours
            );

            if (dedupResult.isDuplicate && dedupResult.matchedIssue) {
              isDuplicate = true;
              matchedIssueNumber = dedupResult.matchedIssue.number;
            } else if (dedupResult.isRegression && dedupResult.matchedClosedIssue) {
              isRegression = true;
              regressedFromIssue = dedupResult.matchedClosedIssue.number;
              labels.push('regression');
              wouldCreateIssue = true;
            } else {
              wouldCreateIssue = true;
            }
          } else {
            // No GitHub service, would create if it was available
            wouldCreateIssue = true;
          }
        } catch (error) {
          logger.warn('[TestConfig] Error checking deduplication:', error);
          // Assume would create issue if dedup check fails
          wouldCreateIssue = true;
        }

        // Build title
        if (wouldCreateIssue || isDuplicate) {
          const emoji = getSeverityEmoji(telemetry.anomalies.severity);
          const primaryAnomaly = formatPrimaryAnomaly(telemetry.anomalies.primaryAnomaly);
          const regressionPrefix = isRegression ? '[Regression] ' : '';
          issueTitle = `${emoji} ${regressionPrefix}[Telemetry] ${primaryAnomaly} (score: ${telemetry.anomalies.anomalyScore}) - ${telemetry.model.modelId}`;
        }
      }
    }

    // Determine if Slack alert would be sent
    const threshold = config.alertThreshold ?? ALERT_THRESHOLDS.warning;
    const wouldSendSlackAlert =
      config.enabled &&
      !!config.slackWorkspaceId &&
      !!config.slackChannelId &&
      telemetry.anomalies.anomalyScore >= threshold;

    // Store the dry run result
    const savedResult = await telemetryDryRunResultRepository.createResult({
      source: 'test',
      telemetrySummary: {
        anomalyScore: telemetry.anomalies.anomalyScore,
        severity: telemetry.anomalies.severity,
        primaryAnomaly: telemetry.anomalies.primaryAnomaly,
        modelId: telemetry.model.modelId,
        provider: telemetry.model.provider,
      },
      action: {
        wouldCreateIssue,
        issueTitle,
        priority,
        labels,
        isRegression,
        regressedFromIssue,
        isDuplicate,
        matchedIssueNumber,
        wouldSendSlackAlert,
        slackChannelId: wouldSendSlackAlert ? config.slackChannelId : undefined,
      },
      fingerprint,
      semanticFingerprint,
    });

    // Transform to response format
    const responseResult = {
      _id: savedResult.id,
      timestamp: savedResult.timestamp.toISOString(),
      source: savedResult.source,
      telemetrySummary: savedResult.telemetrySummary,
      action: savedResult.action,
      fingerprint: savedResult.fingerprint,
      semanticFingerprint: savedResult.semanticFingerprint,
      expiresAt: savedResult.expiresAt.toISOString(),
    };

    res.json({
      result: responseResult,
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
