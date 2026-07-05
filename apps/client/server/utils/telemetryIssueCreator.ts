/**
 * Shared Telemetry Issue Creator
 *
 * Unified logic for creating GitHub issues from telemetry anomalies.
 * Used by both:
 *   - Manual "Create Issue" button (admin API endpoint)
 *   - Auto-create flow (EventBridge Lambda handler)
 *
 * Consolidates: auth via GitHubService, fingerprinting, dedup, regression
 * detection, LLM/rule-based analysis, label management, priority determination.
 */

import { Quest, adminSettingsRepository, cacheRepository } from '@bike4mind/database';
import {
  ContextTelemetry,
  ContextTelemetryAlertsSchema,
  getRecommendedAction,
  type HistoricalBaselines,
} from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { GitHubService } from '@server/services/githubService';
import {
  generateTelemetryFingerprint,
  generateSemanticTelemetryFingerprint,
  extractFingerprintFromBody,
  extractSemanticFingerprintFromBody,
  getSeverityEmoji,
  formatPrimaryAnomaly,
} from '@server/services/telemetryFingerprint';
import { escapeMarkdown } from '@server/utils/markdownEscape';
import { checkFingerprintDedup, type IssueForDedup } from '@server/services/issueDedup';
import { type Priority, REQUIRED_TELEMETRY_LABELS } from '@server/services/issueLabels';
import {
  computeHistoricalBaselines,
  generateRuleBasedAnalysis,
  generateLLMAnalysis,
  formatIssueBody,
  DEFAULT_SLOS,
  type LLMAnalysis,
  type SloConfig,
  type AnalysisSource,
} from '@server/utils/telemetryAnalysis';

// Types

export interface CreateTelemetryIssueOptions {
  /** The telemetry data for the anomaly. */
  telemetry: ContextTelemetry;
  /** GitHub repository in owner/repo format. */
  repository: string;
  /** Optional additional context from the admin (sanitized before inclusion). */
  additionalContext?: string;
  /** Source prefix for analysis tagging. 'manual' for admin button, 'auto' for EventBridge. */
  sourcePrefix: 'manual' | 'auto';
  /** LLM timeout in ms. Defaults to 60000 for manual, 30000 for auto. */
  llmTimeoutMs?: number;
  /** Skip dedup check (admin override). Default false. */
  skipDedup?: boolean;
  /** Pre-computed dedup result (avoids re-fetching issues when caller already did dedup). */
  precomputedDedup?: {
    isRegression: boolean;
    matchedClosedIssue?: IssueForDedup;
  };
  /** Pre-computed analysis (avoids re-generating when caller already ran analysis). */
  precomputedAnalysis?: {
    analysis: LLMAnalysis;
    source: AnalysisSource;
    baselines: HistoricalBaselines | null;
  };
  /** Quest MongoDB _id for caching analysis (used by manual flow). */
  questId?: string;
  /** Quest requestId for caching analysis (used by auto-create flow). */
  requestId?: string;
  /** Logger instance. */
  logger: Logger;
}

export type TelemetryIssueResult =
  | {
      status: 'created';
      issue: { number: number; html_url: string; title: string; state: string; labels: string[] };
      isRegression: boolean;
      hasAnalysis: boolean;
      analysisSource?: AnalysisSource;
    }
  | { status: 'duplicate'; existingIssue: { number: number; html_url: string } }
  | {
      status: 'error';
      code: 'NO_GITHUB_CONNECTION' | 'REPO_NOT_ALLOWED' | 'GITHUB_API_ERROR' | 'INVALID_REPO_FORMAT';
      message: string;
    };

// Helper functions (extracted from telemetryAlert.ts)

/**
 * Determine priority using rule-based fallback logic.
 * Aligned with the priority rules in the plan.
 */
export function getFallbackPriority(telemetry: ContextTelemetry): Priority {
  const { anomalies } = telemetry;
  const score = anomalies.anomalyScore;

  if (anomalies.severity === 'critical' && score >= 70) return 'P0';
  if (anomalies.severity === 'critical') return 'P1';
  if (anomalies.severity === 'high' && score >= 60) return 'P1';
  if (anomalies.severity === 'high') return 'P2';
  return 'P3';
}

/**
 * Fetch existing open issues with the telemetry label.
 */
export async function fetchExistingTelemetryIssues(
  githubService: GitHubService,
  repoFullName: string,
  logger: Logger
): Promise<IssueForDedup[]> {
  try {
    // Fetch up to 200 most recently updated open telemetry issues (2 pages).
    // Sorted by updated desc so the most relevant issues for dedup come first.
    const [page1, page2] = await Promise.all([
      githubService.listIssues(repoFullName, {
        state: 'open',
        labels: 'telemetry',
        per_page: 100,
        page: 1,
        sort: 'updated',
        direction: 'desc',
      }),
      githubService.listIssues(repoFullName, {
        state: 'open',
        labels: 'telemetry',
        per_page: 100,
        page: 2,
        sort: 'updated',
        direction: 'desc',
      }),
    ]);
    const issues = [...page1, ...page2];

    return issues.map(issue => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body ?? null,
      closedAt: null,
      fingerprint: extractFingerprintFromBody(issue.body),
      semanticFingerprint: extractSemanticFingerprintFromBody(issue.body),
    }));
  } catch (error) {
    logger.warn('Failed to fetch open issues', { error });
    return [];
  }
}

/**
 * Fetch recently closed issues with the telemetry label for regression detection.
 */
export async function fetchRecentlyClosedIssues(
  githubService: GitHubService,
  repoFullName: string,
  lookbackDays: number,
  logger: Logger
): Promise<IssueForDedup[]> {
  try {
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - lookbackDays);

    // Fetch up to 200 most recently updated closed telemetry issues (2 pages).
    const [page1, page2] = await Promise.all([
      githubService.listIssues(repoFullName, {
        state: 'closed',
        labels: 'telemetry',
        since: sinceDate.toISOString(),
        per_page: 100,
        page: 1,
        sort: 'updated',
        direction: 'desc',
      }),
      githubService.listIssues(repoFullName, {
        state: 'closed',
        labels: 'telemetry',
        since: sinceDate.toISOString(),
        per_page: 100,
        page: 2,
        sort: 'updated',
        direction: 'desc',
      }),
    ]);
    const issues = [...page1, ...page2];

    return issues.map(issue => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      body: issue.body ?? null,
      closedAt: issue.closed_at ?? null,
      fingerprint: extractFingerprintFromBody(issue.body),
      semanticFingerprint: extractSemanticFingerprintFromBody(issue.body),
    }));
  } catch (error) {
    logger.warn('Failed to fetch closed issues', { error });
    return [];
  }
}

/**
 * Ensure required labels exist in the repository.
 * Creates them if they don't exist.
 */
export async function ensureLabelsExist(
  githubService: GitHubService,
  repoFullName: string,
  logger: Logger
): Promise<void> {
  try {
    const existingLabels = await githubService.listLabels(repoFullName);
    const existingLabelNames = new Set(existingLabels.map(l => l.name));

    for (const labelDef of REQUIRED_TELEMETRY_LABELS) {
      if (!existingLabelNames.has(labelDef.name)) {
        try {
          await githubService.createLabel(repoFullName, {
            name: labelDef.name,
            color: labelDef.color,
            description: labelDef.description,
          });
          logger.info(`Created label: ${labelDef.name}`);
        } catch (labelError) {
          logger.debug(`Could not create label ${labelDef.name}`, { error: labelError });
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to ensure labels exist', { error });
  }
}

// Main function

/**
 * Create a GitHub issue from telemetry anomaly data.
 *
 * Shared by both manual (admin button) and auto (EventBridge) flows.
 * Returns a discriminated union result for proper error handling by each caller.
 */
export async function createTelemetryIssue(options: CreateTelemetryIssueOptions): Promise<TelemetryIssueResult> {
  const {
    telemetry,
    repository,
    additionalContext,
    sourcePrefix,
    llmTimeoutMs = sourcePrefix === 'auto' ? 30000 : 60000,
    skipDedup = false,
    questId,
    requestId,
    logger,
  } = options;

  // 1. Validate repository format
  if (!repository.match(/^[\w.-]+\/[\w.-]+$/)) {
    return {
      status: 'error',
      code: 'INVALID_REPO_FORMAT',
      message: 'Invalid repository format. Use owner/repo format.',
    };
  }

  // 2. Get GitHubService
  const githubService = await GitHubService.forSystem(logger);
  if (!githubService) {
    return {
      status: 'error',
      code: 'NO_GITHUB_CONNECTION',
      message: 'GitHub integration not configured. Set up a system GitHub connection in admin settings.',
    };
  }

  // 3. Generate fingerprints
  const fingerprint = generateTelemetryFingerprint(telemetry);
  const semanticFingerprint = generateSemanticTelemetryFingerprint(telemetry);

  logger.debug('Generated fingerprints', {
    fingerprint: fingerprint.substring(0, 8) + '...',
    semanticFingerprint: semanticFingerprint.substring(0, 8) + '...',
  });

  // 3.5. Fetch alert settings once (used by both dedup and analysis steps)
  const needsAlertSettings = !options.precomputedDedup || !options.precomputedAnalysis;
  const alertConfig = needsAlertSettings
    ? await (async () => {
        const raw = await adminSettingsRepository.getSettingsValue('contextTelemetryAlerts');
        const parsed = ContextTelemetryAlertsSchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      })()
    : null;

  // 4. Dedup and regression detection
  let isRegression = false;
  let matchedClosedIssue: IssueForDedup | undefined;

  if (options.precomputedDedup) {
    // Use pre-computed dedup result (auto-create handler already did this)
    isRegression = options.precomputedDedup.isRegression;
    matchedClosedIssue = options.precomputedDedup.matchedClosedIssue;
  } else if (!skipDedup) {
    const lookbackDays = alertConfig?.regressionLookbackDays ?? 30;
    const gracePeriodHours = alertConfig?.regressionGracePeriodHours ?? 48;

    const [openIssues, closedIssues] = await Promise.all([
      fetchExistingTelemetryIssues(githubService, repository, logger),
      fetchRecentlyClosedIssues(githubService, repository, lookbackDays, logger),
    ]);

    const dedupResult = checkFingerprintDedup(
      fingerprint,
      semanticFingerprint,
      openIssues,
      closedIssues,
      gracePeriodHours
    );

    if (dedupResult.isDuplicate && dedupResult.matchedIssue) {
      const [owner, repo] = repository.split('/');
      return {
        status: 'duplicate',
        existingIssue: {
          number: dedupResult.matchedIssue.number,
          html_url: `https://github.com/${owner}/${repo}/issues/${dedupResult.matchedIssue.number}`,
        },
      };
    }

    if (dedupResult.isRegression && dedupResult.matchedClosedIssue) {
      isRegression = true;
      matchedClosedIssue = dedupResult.matchedClosedIssue;
    }
  }

  // 5-6. Analysis: use pre-computed or generate fresh
  let analysisResult: LLMAnalysis | null = null;
  let analysisSourceTag: AnalysisSource | undefined;
  let baselines: HistoricalBaselines | null = null;

  if (options.precomputedAnalysis) {
    // Use pre-computed analysis (auto-create handler already generated this)
    analysisResult = options.precomputedAnalysis.analysis;
    analysisSourceTag = options.precomputedAnalysis.source;
    baselines = options.precomputedAnalysis.baselines;
  } else {
    const slos: SloConfig = {
      sloResponseTimeP95Ms: alertConfig?.sloResponseTimeP95Ms ?? DEFAULT_SLOS.sloResponseTimeP95Ms,
      sloFirstTokenTimeMs: alertConfig?.sloFirstTokenTimeMs ?? DEFAULT_SLOS.sloFirstTokenTimeMs,
      sloErrorRatePercent: alertConfig?.sloErrorRatePercent ?? DEFAULT_SLOS.sloErrorRatePercent,
      sloContextUtilizationPercent:
        alertConfig?.sloContextUtilizationPercent ?? DEFAULT_SLOS.sloContextUtilizationPercent,
    };

    const baselineWindowDays = alertConfig?.baselineWindowDays ?? 7;
    try {
      baselines = await computeHistoricalBaselines(
        telemetry.model.modelId,
        telemetry.model.provider,
        baselineWindowDays
      );
    } catch (err) {
      logger.warn('Failed to compute baselines', { error: err instanceof Error ? err.message : err });
    }

    // Generate analysis (LLM, falls back to rule-based)
    const llmModelId = alertConfig?.modelId;
    const analysisStart = Date.now();

    if (llmModelId) {
      try {
        logger.info(`Generating LLM analysis for ${sourcePrefix} issue`, { model: llmModelId });
        analysisResult = await generateLLMAnalysis(
          telemetry,
          {
            modelId: llmModelId,
            temperature: alertConfig?.temperature ?? 0.3,
            maxTokens: alertConfig?.maxTokens ?? 2000,
            timeoutMs: Math.min(alertConfig?.timeoutMs ?? llmTimeoutMs, llmTimeoutMs),
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
        analysisSourceTag = `${sourcePrefix}-llm` as AnalysisSource;
        logger.info('LLM analysis completed', { latencyMs: Date.now() - analysisStart });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn(`LLM analysis failed, falling back to rule-based`, {
          error: errorMessage,
          latencyMs: Date.now() - analysisStart,
        });
        analysisResult = generateRuleBasedAnalysis(telemetry, slos, baselines);
        analysisSourceTag = `${sourcePrefix}-rule-based` as AnalysisSource;
      }
    } else {
      logger.info(`No LLM configured, using rule-based analysis for ${sourcePrefix} issue`);
      analysisResult = generateRuleBasedAnalysis(telemetry, slos, baselines);
      analysisSourceTag = `${sourcePrefix}-rule-based` as AnalysisSource;
    }
  }

  // 7. Cache analysis on Quest document
  const cacheFilter = questId ? { _id: questId } : requestId ? { requestId } : null;
  if (analysisResult && cacheFilter) {
    try {
      await Quest.updateOne(cacheFilter, {
        $set: {
          'promptMeta.contextTelemetry.cachedAnalysis': {
            analysis: analysisResult,
            analysisSource: analysisSourceTag,
            historicalBaselines: baselines,
            cachedAt: new Date().toISOString(),
          },
        },
      });
    } catch (cacheErr) {
      logger.warn('Failed to cache analysis on Quest', {
        error: cacheErr instanceof Error ? cacheErr.message : cacheErr,
      });
    }
  }

  // 8. Determine priority
  const priority = getFallbackPriority(telemetry);

  // 9. Ensure labels exist
  await ensureLabelsExist(githubService, repository, logger);

  // 10. Build title
  const { anomalies, model } = telemetry;
  const emoji = getSeverityEmoji(anomalies.severity);
  const safePrimaryAnomaly = escapeMarkdown(formatPrimaryAnomaly(anomalies.primaryAnomaly));
  const safeModelId = escapeMarkdown(model.modelId);
  const regressionPrefix = isRegression ? '[Regression] ' : '';
  const title = `${emoji} ${regressionPrefix}[Telemetry] ${safePrimaryAnomaly} (score: ${anomalies.anomalyScore}) - ${safeModelId}`;

  // 11. Build body
  const body = formatIssueBody(telemetry, {
    analysis: analysisResult ?? undefined,
    analysisSource: analysisSourceTag,
    fingerprint,
    semanticFingerprint,
    priority,
    isRegression,
    matchedClosedIssue,
    additionalContext,
  });

  // 12. Build labels
  const labels = ['bug', 'telemetry', priority];
  if (isRegression) {
    labels.push('regression');
  }

  // 13. Atomic claim to prevent race conditions (concurrent admin clicks, or manual
  // click racing the auto-create Lambda). Short TTL; if claim fails, another
  // request is already handling this fingerprint.
  const claimKey = `telemetry-issue-claim:${fingerprint}`;
  try {
    const claimResult = await cacheRepository.claimDedup(claimKey, { claimedAt: Date.now() }, 300);
    if (!claimResult.claimed) {
      logger.info('Another request is already creating an issue for this fingerprint, treating as duplicate');
      return {
        status: 'duplicate',
        existingIssue: {
          number: 0,
          html_url: `https://github.com/${repository}/issues`,
        },
      };
    }
  } catch (claimErr) {
    // If claim check fails, proceed anyway - better to risk a duplicate than to block creation
    logger.warn('Failed to check issue creation claim, proceeding', {
      error: claimErr instanceof Error ? claimErr.message : claimErr,
    });
  }

  // 14. Create the issue
  try {
    const issue = await githubService.createIssue(repository, { title, body, labels });

    if (!issue) {
      return {
        status: 'error',
        code: 'REPO_NOT_ALLOWED',
        message: `Repository '${repository}' is not in the allowed list for the system GitHub connection.`,
      };
    }

    logger.info('Created GitHub issue', {
      issueNumber: issue.number,
      issueUrl: issue.html_url,
      priority,
      isRegression,
      source: sourcePrefix,
    });

    return {
      status: 'created',
      issue: {
        number: issue.number,
        html_url: issue.html_url,
        title: issue.title,
        state: issue.state,
        labels: issue.labels.map(l => l.name),
      },
      isRegression,
      hasAnalysis: !!analysisResult,
      analysisSource: analysisSourceTag,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Failed to create GitHub issue', { error: errorMessage });
    return { status: 'error', code: 'GITHUB_API_ERROR', message: `GitHub API error: ${errorMessage}` };
  }
}
