import { withEventContext } from '@server/events/utils';
import { TelemetryEvents } from '@server/utils/eventBus';
import {
  AnomalyAlertService,
  type ISlackMessageSender,
  type SlackMessage,
  type CheckAndAlertOptions,
} from '@bike4mind/services';
import {
  Quest,
  slackDevWorkspaceRepository,
  cacheRepository,
  telemetryDryRunResultRepository,
  adminSettingsRepository,
} from '@bike4mind/database';
import { decryptToken } from '@server/security/tokenEncryption';
import { SlackClient } from '@bike4mind/slack';
import { GitHubService } from '@server/services/githubService';
import {
  ALERT_THRESHOLDS,
  ContextTelemetryAlerts,
  ContextTelemetryAlertsSchema,
  getRecommendedAction,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  generateTelemetryFingerprint,
  generateSemanticTelemetryFingerprint,
  getSeverityEmoji,
  formatPrimaryAnomaly,
} from '@server/services/telemetryFingerprint';
import { checkFingerprintDedup, type IssueForDedup } from '@server/services/issueDedup';
import {
  computeHistoricalBaselines,
  generateRuleBasedAnalysis,
  generateLLMAnalysis,
  DEFAULT_SLOS,
  type LLMAnalysis,
  type SloConfig,
  type AnalysisSource,
} from '@server/utils/telemetryAnalysis';
import {
  getFallbackPriority,
  fetchExistingTelemetryIssues,
  fetchRecentlyClosedIssues,
  createTelemetryIssue,
} from '@server/utils/telemetryIssueCreator';

// Cache key prefixes
const CACHE_PREFIX_DUP_ALERT = 'telemetry-dup-alert:';
const CACHE_PREFIX_ISSUE_CLAIM = 'telemetry-issue-claim:';
const CACHE_PREFIX_RATE_LIMIT = 'telemetry-rate-limit:';

// getFallbackPriority, fetchExistingTelemetryIssues, fetchRecentlyClosedIssues are shared
// with the manual create-issue endpoint via @server/utils/telemetryIssueCreator.
// createGitHubIssue and ensureLabelsExist were consolidated into createTelemetryIssue there too.

/**
 * Atomically check and increment rate limit.
 * Uses MongoDB atomic operations to prevent race conditions.
 *
 * @returns Object with exceeded flag and current count
 */
async function checkAndIncrementRateLimit(
  config: ContextTelemetryAlerts,
  logger: Logger
): Promise<{ exceeded: boolean; count: number }> {
  const maxIssuesPerHour = config.maxIssuesPerHour ?? 50;
  const cacheKey = `${CACHE_PREFIX_RATE_LIMIT}${new Date().toISOString().slice(0, 13)}`; // Hour-level key
  const ttlMs = 3600 * 1000; // 1 hour TTL

  try {
    // Use atomic increment with conditional - prevents race conditions
    const result = await cacheRepository.incrementCounterConditional(cacheKey, maxIssuesPerHour, ttlMs);

    if (!result.success) {
      logger.warn('Rate limit exceeded for issue creation', {
        currentCount: result.count,
        maxIssuesPerHour,
      });
      return { exceeded: true, count: result.count };
    }

    return { exceeded: false, count: result.count };
  } catch (error) {
    logger.warn('Failed to check/increment rate limit', { error });
    return { exceeded: false, count: 0 }; // Allow creation on error
  }
}

/**
 * Decrement rate limit counter (rollback on failure).
 */
async function decrementRateLimitCounter(logger: Logger): Promise<void> {
  const cacheKey = `${CACHE_PREFIX_RATE_LIMIT}${new Date().toISOString().slice(0, 13)}`;

  try {
    await cacheRepository.decrementCounter(cacheKey);
  } catch (error) {
    logger.warn('Failed to decrement rate limit counter', { error });
  }
}

/**
 * Telemetry Alert Event Handler
 *
 * Processes telemetry alert events published by ChatCompletionProcess.
 * This handler runs in a dedicated Lambda, ensuring alerts complete
 * even after the main request Lambda terminates.
 *
 * Features (aligned with LiveOps Triage):
 * - Fingerprinting for deterministic deduplication
 * - GitHub issue deduplication (fingerprint matching against open issues)
 * - Regression detection (fingerprint matching against closed issues)
 * - Priority determination (rule-based, P0-P3)
 * - GitHub issue auto-creation with embedded fingerprints
 * - Slack alerting with GitHub issue links
 * - Duplicate alert cooldown
 * - Rate limiting for issue creation
 */
export const handler = withEventContext(async (event, logger) => {
  const { telemetry, alertConfig, requestId } = TelemetryEvents.Alert.schema.parse(event.properties);

  // Add correlation metadata for tracing
  logger.updateMetadata({
    handler: 'telemetryAlert',
    questId: requestId,
    anomalyScore: telemetry.anomalies.anomalyScore,
    primaryAnomaly: telemetry.anomalies.primaryAnomaly,
  });

  const isDryRun = alertConfig.dryRun ?? false;

  logger.info('Processing alert event', {
    anomalyScore: telemetry.anomalies.anomalyScore,
    alertThreshold: alertConfig.alertThreshold,
    slackConfigured: !!(alertConfig.slackWorkspaceId && alertConfig.slackChannelId),
    githubConfigured: !!(alertConfig.githubOwner && alertConfig.githubRepo),
    autoCreateIssues: alertConfig.autoCreateIssues,
    dryRun: isDryRun,
  });

  const fingerprint = generateTelemetryFingerprint(telemetry);
  const semanticFingerprint = generateSemanticTelemetryFingerprint(telemetry);

  logger.debug('Generated fingerprints', {
    fingerprint: fingerprint.substring(0, 8) + '...',
    semanticFingerprint: semanticFingerprint.substring(0, 8) + '...',
  });

  let githubIssueUrl: string | undefined;
  let isDuplicateAlert = false;
  let isRegression = false;
  let matchedClosedIssue: IssueForDedup | undefined;
  let matchedOpenIssueNumber: number | undefined;
  let wouldCreateIssue = false;
  let dryRunIssueTitle: string | undefined;
  const dryRunLabels: string[] = ['bug', 'telemetry'];

  // Process GitHub issue creation (if enabled)
  const issueThreshold = alertConfig.alertThreshold ?? ALERT_THRESHOLDS.warning;
  if (
    alertConfig.autoCreateIssues &&
    telemetry.anomalies.anomalyScore >= issueThreshold &&
    alertConfig.githubOwner &&
    alertConfig.githubRepo
  ) {
    // Note: Rate limiting is checked atomically when creating issues
    {
      // Atomic claim to prevent race conditions between parallel Lambdas
      const claimKey = `${CACHE_PREFIX_ISSUE_CLAIM}${fingerprint}`;
      const claimResult = await cacheRepository.claimDedup(
        claimKey,
        { claimedAt: Date.now() },
        300 // 5 minute TTL
      );

      if (!claimResult.claimed) {
        // Another Lambda claimed this fingerprint - let it handle the issue creation
        // The dedup logic will catch this if both somehow proceed
        logger.info('Another Lambda is handling this fingerprint, skipping');
        return;
      }

      // We claimed the fingerprint - proceed with processing
      // Fetch existing issues (parallel)
      const githubService = await GitHubService.forSystem(logger);
      if (githubService) {
        const repoFullName = `${alertConfig.githubOwner}/${alertConfig.githubRepo}`;
        const lookbackDays = alertConfig.regressionLookbackDays ?? 30;
        const gracePeriodHours = alertConfig.regressionGracePeriodHours ?? 48;

        // Parallelize: fetch issues + compute historical baselines
        const baselineWindowDays = alertConfig.baselineWindowDays ?? 7;
        const [openIssues, closedIssues, baselines] = await Promise.all([
          fetchExistingTelemetryIssues(githubService, repoFullName, logger),
          fetchRecentlyClosedIssues(githubService, repoFullName, lookbackDays, logger),
          computeHistoricalBaselines(telemetry.model.modelId, telemetry.model.provider, baselineWindowDays).catch(
            err => {
              logger.warn('Failed to compute baselines', { error: err instanceof Error ? err.message : err });
              return null;
            }
          ),
        ]);

        logger.debug('Fetched existing issues and baselines', {
          openCount: openIssues.length,
          closedCount: closedIssues.length,
          hasBaselines: !!baselines,
        });

        const dedupResult = checkFingerprintDedup(
          fingerprint,
          semanticFingerprint,
          openIssues,
          closedIssues,
          gracePeriodHours
        );

        const priority = getFallbackPriority(telemetry);

        // Generate analysis for non-duplicate issues (LLM with rule-based fallback)
        let analysisResult: LLMAnalysis | null = null;
        let analysisSourceTag: AnalysisSource | undefined;

        if (!dedupResult.isDuplicate) {
          // Load SLO config from alert settings
          const alertSettingsRaw = await adminSettingsRepository.getSettingsValue('contextTelemetryAlerts');
          const alertSettingsParsed = ContextTelemetryAlertsSchema.safeParse(alertSettingsRaw);
          const alertSettingsConfig = alertSettingsParsed.success ? alertSettingsParsed.data : null;

          const slos: SloConfig = {
            sloResponseTimeP95Ms: alertSettingsConfig?.sloResponseTimeP95Ms ?? DEFAULT_SLOS.sloResponseTimeP95Ms,
            sloFirstTokenTimeMs: alertSettingsConfig?.sloFirstTokenTimeMs ?? DEFAULT_SLOS.sloFirstTokenTimeMs,
            sloErrorRatePercent: alertSettingsConfig?.sloErrorRatePercent ?? DEFAULT_SLOS.sloErrorRatePercent,
            sloContextUtilizationPercent:
              alertSettingsConfig?.sloContextUtilizationPercent ?? DEFAULT_SLOS.sloContextUtilizationPercent,
          };

          const llmModelId = alertSettingsConfig?.modelId;
          const analysisStart = Date.now();

          if (llmModelId) {
            try {
              logger.info('Generating LLM analysis for auto-issue', { model: llmModelId });
              analysisResult = await generateLLMAnalysis(
                telemetry,
                {
                  modelId: llmModelId,
                  temperature: alertSettingsConfig?.temperature ?? 0.3,
                  maxTokens: alertSettingsConfig?.maxTokens ?? 2000,
                  timeoutMs: Math.min(alertSettingsConfig?.timeoutMs ?? 30000, 30000), // Cap at 30s for auto-alerts
                },
                logger,
                slos,
                baselines
              );
              // Force system-calculated severity (never LLM-determined)
              analysisResult = {
                ...analysisResult,
                severity: telemetry.anomalies.severity,
                recommendedAction: getRecommendedAction(telemetry.anomalies.anomalyScore),
              };
              analysisSourceTag = 'auto-llm';
              logger.info('LLM analysis completed', { latencyMs: Date.now() - analysisStart });
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);
              logger.warn('LLM analysis failed, falling back to rule-based', {
                error: errorMessage,
                latencyMs: Date.now() - analysisStart,
              });
              analysisResult = generateRuleBasedAnalysis(telemetry, slos, baselines);
              analysisSourceTag = 'auto-rule-based';
            }
          } else {
            logger.info('No LLM configured, using rule-based analysis for auto-issue');
            analysisResult = generateRuleBasedAnalysis(telemetry, slos, baselines);
            analysisSourceTag = 'auto-rule-based';
          }

          logger.info('Analysis generated for auto-issue', {
            source: analysisSourceTag,
            latencyMs: Date.now() - analysisStart,
            findingsCount: analysisResult?.findings.length ?? 0,
          });

          // Cache analysis on Quest document for admin UI. Both auto-alert and manual
          // analyze API can write cachedAnalysis on the same Quest; last-write-wins is
          // acceptable since the manual analyze API uses ?force=true to bypass cache.
          if (analysisResult && requestId) {
            try {
              await Quest.updateOne(
                { requestId },
                {
                  $set: {
                    'promptMeta.contextTelemetry.cachedAnalysis': {
                      analysis: analysisResult,
                      analysisSource: analysisSourceTag,
                      historicalBaselines: baselines,
                      cachedAt: new Date().toISOString(),
                    },
                  },
                }
              );
            } catch (cacheErr) {
              logger.warn('Failed to cache analysis on Quest', {
                error: cacheErr instanceof Error ? cacheErr.message : cacheErr,
              });
            }
          }
        }

        if (dedupResult.isDuplicate && dedupResult.matchedIssue) {
          // Found a duplicate - use existing issue URL
          githubIssueUrl = `https://github.com/${alertConfig.githubOwner}/${alertConfig.githubRepo}/issues/${dedupResult.matchedIssue.number}`;
          isDuplicateAlert = true;
          matchedOpenIssueNumber = dedupResult.matchedIssue.number;
          dryRunLabels.push(priority);

          logger.info('Found duplicate issue', {
            issueNumber: dedupResult.matchedIssue.number,
            githubIssueUrl,
            dryRun: isDryRun,
          });

          if (isDryRun) {
            logger.info('DRY RUN - Would skip issue creation (duplicate exists)', {
              matchedIssueNumber: dedupResult.matchedIssue.number,
              matchedIssueTitle: dedupResult.matchedIssue.title,
              wouldSendSlackAlert: true,
              alertType: 'recurring',
            });
          } else {
            // Check cooldown for duplicate alerts using atomic claim
            const cooldownHours = alertConfig.duplicateAlertCooldownHours ?? 24;
            const cooldownKey = `${CACHE_PREFIX_DUP_ALERT}${fingerprint}`;
            const cooldownTtlMs = cooldownHours * 60 * 60 * 1000;

            // Use claimDedup for atomic check-and-set - prevents race conditions
            const cooldownClaim = await cacheRepository.claimDedup(cooldownKey, { alerted: true }, cooldownTtlMs);

            if (!cooldownClaim.claimed) {
              // Someone else already claimed this cooldown - we're within cooldown
              logger.info('Duplicate within cooldown, skipping Slack', {
                issueNumber: dedupResult.matchedIssue.number,
                cooldownHours,
              });
              return; // Skip Slack alert entirely
            }

            // We claimed the cooldown - proceed with alert
            logger.debug('Claimed cooldown for duplicate alert');
          }
        } else if (dedupResult.isRegression && dedupResult.matchedClosedIssue) {
          // Regression detected - create new issue with regression label
          isRegression = true;
          matchedClosedIssue = dedupResult.matchedClosedIssue;
          wouldCreateIssue = true;
          dryRunLabels.push(priority, 'regression');

          logger.info('Regression detected', {
            closedIssueNumber: dedupResult.matchedClosedIssue.number,
            dryRun: isDryRun,
          });

          if (isDryRun) {
            const severityEmoji = getSeverityEmoji(telemetry.anomalies.severity);
            const primaryAnomaly = formatPrimaryAnomaly(telemetry.anomalies.primaryAnomaly);
            dryRunIssueTitle = `${severityEmoji} [Telemetry] ${primaryAnomaly} (score: ${telemetry.anomalies.anomalyScore}) - ${telemetry.model.modelId}`;
            logger.info('DRY RUN - Would create REGRESSION issue', {
              wouldCreateIssue: true,
              title: dryRunIssueTitle,
              priority,
              labels: dryRunLabels,
              isRegression: true,
              regressedFromIssue: dedupResult.matchedClosedIssue.number,
              fingerprint: fingerprint.substring(0, 12) + '...',
              wouldSendSlackAlert: !!(alertConfig.slackWorkspaceId && alertConfig.slackChannelId),
            });
          } else {
            const rateLimit = await checkAndIncrementRateLimit(alertConfig, logger);
            if (!rateLimit.exceeded) {
              const result = await createTelemetryIssue({
                telemetry,
                repository: repoFullName,
                sourcePrefix: 'auto',
                llmTimeoutMs: 30000,
                skipDedup: true,
                precomputedDedup: { isRegression, matchedClosedIssue },
                precomputedAnalysis: analysisResult
                  ? { analysis: analysisResult, source: analysisSourceTag!, baselines }
                  : undefined,
                requestId,
                logger,
              });

              if (result.status === 'created') {
                githubIssueUrl = result.issue.html_url;
              } else {
                // Issue creation failed - rollback rate limit
                await decrementRateLimitCounter(logger);
              }
            }
          }
        } else {
          // New issue
          wouldCreateIssue = true;
          dryRunLabels.push(priority);

          if (isDryRun) {
            const severityEmoji = getSeverityEmoji(telemetry.anomalies.severity);
            const primaryAnomaly = formatPrimaryAnomaly(telemetry.anomalies.primaryAnomaly);
            dryRunIssueTitle = `${severityEmoji} [Telemetry] ${primaryAnomaly} (score: ${telemetry.anomalies.anomalyScore}) - ${telemetry.model.modelId}`;
            logger.info('DRY RUN - Would create NEW issue', {
              wouldCreateIssue: true,
              title: dryRunIssueTitle,
              priority,
              labels: dryRunLabels,
              isRegression: false,
              fingerprint: fingerprint.substring(0, 12) + '...',
              semanticFingerprint: semanticFingerprint.substring(0, 12) + '...',
              wouldSendSlackAlert: !!(alertConfig.slackWorkspaceId && alertConfig.slackChannelId),
              model: telemetry.model.modelId,
              provider: telemetry.model.provider,
              severity: telemetry.anomalies.severity,
              anomalyScore: telemetry.anomalies.anomalyScore,
            });
          } else {
            const rateLimit = await checkAndIncrementRateLimit(alertConfig, logger);
            if (!rateLimit.exceeded) {
              const result = await createTelemetryIssue({
                telemetry,
                repository: repoFullName,
                sourcePrefix: 'auto',
                llmTimeoutMs: 30000,
                skipDedup: true,
                precomputedDedup: { isRegression: false },
                precomputedAnalysis: analysisResult
                  ? { analysis: analysisResult, source: analysisSourceTag!, baselines }
                  : undefined,
                requestId,
                logger,
              });

              if (result.status === 'created') {
                githubIssueUrl = result.issue.html_url;
              } else {
                // Issue creation failed - rollback rate limit
                await decrementRateLimitCounter(logger);
              }
            }
          }
        }
      }
    }
  }

  // Create Slack sender if configured
  let slackSender: ISlackMessageSender | undefined;

  if (alertConfig.slackWorkspaceId && alertConfig.slackChannelId) {
    const workspace = await slackDevWorkspaceRepository.findByIdWithCredentials(alertConfig.slackWorkspaceId);

    if (workspace?.slackBotToken) {
      const decryptedToken = decryptToken(workspace.slackBotToken);

      if (decryptedToken) {
        const slackClient = new SlackClient(decryptedToken, logger);

        slackSender = {
          sendMessage: async (_workspaceId: string, channelId: string, message: SlackMessage) => {
            await slackClient.sendMessage({
              channel: channelId,
              text: message.text,
              blocks: message.blocks,
            });
          },
        };

        logger.info('Slack sender configured', {
          workspaceId: alertConfig.slackWorkspaceId,
          channelId: alertConfig.slackChannelId,
        });
      } else {
        logger.error('Failed to decrypt bot token - alerts will not be sent', {
          workspaceId: alertConfig.slackWorkspaceId,
        });
      }
    } else {
      logger.error('Workspace not found or missing bot token - alerts will not be sent', {
        workspaceId: alertConfig.slackWorkspaceId,
        workspaceFound: !!workspace,
      });
    }
  }

  // Send Slack alert (with GitHub issue link if available)
  if (isDryRun) {
    const wouldSendAlert = !!(alertConfig.slackWorkspaceId && alertConfig.slackChannelId);
    const threshold = alertConfig.alertThreshold ?? ALERT_THRESHOLDS.warning;
    const wouldMeetThreshold = telemetry.anomalies.anomalyScore >= threshold;

    logger.info('DRY RUN - Slack alert summary', {
      wouldSendAlert,
      wouldMeetThreshold,
      slackConfigured: wouldSendAlert,
      channelId: alertConfig.slackChannelId,
      anomalyScore: telemetry.anomalies.anomalyScore,
      threshold,
      githubIssueUrl: githubIssueUrl ?? '(would be created)',
      isDuplicateAlert,
      isRegression,
    });

    logger.info('DRY RUN COMPLETE', {
      questId: requestId,
      dryRun: true,
      summary: {
        anomalyScore: telemetry.anomalies.anomalyScore,
        severity: telemetry.anomalies.severity,
        primaryAnomaly: telemetry.anomalies.primaryAnomaly,
        priority: getFallbackPriority(telemetry),
        wouldCreateIssue: !isDuplicateAlert && alertConfig.autoCreateIssues,
        wouldSendSlackAlert: wouldSendAlert && wouldMeetThreshold,
        isDuplicate: isDuplicateAlert,
        isRegression,
      },
    });

    // Store dry run result in MongoDB for UI visibility
    try {
      await telemetryDryRunResultRepository.createResult({
        source: 'real',
        questId: requestId,
        telemetrySummary: {
          anomalyScore: telemetry.anomalies.anomalyScore,
          severity: telemetry.anomalies.severity,
          primaryAnomaly: telemetry.anomalies.primaryAnomaly,
          modelId: telemetry.model.modelId,
          provider: telemetry.model.provider,
        },
        action: {
          wouldCreateIssue: wouldCreateIssue && !isDuplicateAlert,
          issueTitle: dryRunIssueTitle,
          priority: getFallbackPriority(telemetry),
          labels: dryRunLabels,
          isRegression,
          regressedFromIssue: matchedClosedIssue?.number,
          isDuplicate: isDuplicateAlert,
          matchedIssueNumber: matchedOpenIssueNumber,
          wouldSendSlackAlert: wouldSendAlert && wouldMeetThreshold,
          slackChannelId: wouldSendAlert ? alertConfig.slackChannelId : undefined,
        },
        fingerprint,
        semanticFingerprint,
      });
      logger.debug('Stored dry run result in MongoDB');
    } catch (storeError) {
      logger.warn('Failed to store dry run result', { error: storeError });
    }
  } else if (slackSender) {
    const alertService = new AnomalyAlertService({
      logger,
      alertConfig,
      cacheRepository,
      slackSender,
    });

    // Pass issue URL and duplicate status to customize Slack message
    const alertOptions: CheckAndAlertOptions = {
      githubIssueUrl,
      isRecurring: isDuplicateAlert,
    };

    const sent = await alertService.checkAndAlert(telemetry, alertOptions);

    logger.info(`Alert ${sent ? 'sent to Slack' : 'suppressed (dedup or below threshold)'}`, {
      questId: requestId,
      anomalyScore: telemetry.anomalies.anomalyScore,
      githubIssueUrl,
      isDuplicateAlert,
      isRegression,
    });
  } else {
    logger.warn('No Slack sender configured, skipping alert', {
      questId: requestId,
    });
  }
});
