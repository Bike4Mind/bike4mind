import type { ContextTelemetry, ContextTelemetryAlerts, ICacheRepository } from '@bike4mind/common';
import { ALERT_THRESHOLDS, sanitizeTelemetryError } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';

/**
 * Slack Block Kit message structure
 */
interface SlackBlock {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: Array<{
    type: string;
    text?: string | { type: string; text: string; emoji?: boolean };
    style?: string;
    url?: string;
  }>;
  fields?: Array<{
    type: string;
    text: string;
  }>;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

/**
 * Deduplication entry for tracking recent alerts
 */
interface DedupEntry {
  dedupKey: string;
  lastAlertTime: number;
  count: number;
}

/**
 * Interface for Slack message sender (dependency injection)
 * Allows the caller to provide their own Slack client implementation
 */
export interface ISlackMessageSender {
  /**
   * Send a Block Kit message to the configured channel
   * @param workspaceId - MongoDB ObjectId of the Slack workspace
   * @param channelId - Slack channel ID
   * @param message - Block Kit message to send
   */
  sendMessage(workspaceId: string, channelId: string, message: SlackMessage): Promise<void>;
}

/**
 * Configuration for AnomalyAlertService
 */
interface AnomalyAlertServiceConfig {
  logger: Logger;
  alertConfig: ContextTelemetryAlerts;
  /**
   * Optional cache repository for distributed deduplication.
   * When provided, uses MongoDB for cross-instance dedup (recommended for serverless).
   * Falls back to in-memory cache when not provided.
   */
  cacheRepository?: ICacheRepository;
  /**
   * Slack message sender implementation.
   * Required for sending alerts when slackWorkspaceId and slackChannelId are configured.
   */
  slackSender?: ISlackMessageSender;
}

/**
 * Options for checkAndAlert method
 */
export interface CheckAndAlertOptions {
  /** URL to the GitHub issue (included in Slack message if provided) */
  githubIssueUrl?: string;
  /** Whether this is a recurring alert for an existing issue */
  isRecurring?: boolean;
}

/**
 * AnomalyAlertService
 *
 * Sends Slack alerts when telemetry anomaly scores exceed thresholds.
 * Implements pattern-based deduplication to avoid alert fatigue.
 *
 * Supports two deduplication modes:
 * 1. Distributed (recommended): Uses MongoDB CacheModel for cross-instance dedup
 * 2. In-memory fallback: Per-instance Map for testing or when DB unavailable
 */
export class AnomalyAlertService {
  private logger: Logger;
  private config: ContextTelemetryAlerts;
  private cacheRepository?: ICacheRepository;
  private slackSender?: ISlackMessageSender;
  private dedupCache: Map<string, DedupEntry> = new Map();
  // Maximum cache entries to prevent memory leaks in long-running processes
  private static readonly MAX_CACHE_ENTRIES = 1000;
  // Cache key prefix for distributed dedup
  private static readonly DEDUP_KEY_PREFIX = 'anomaly-alert-dedup:';

  constructor(config: AnomalyAlertServiceConfig);
  /** @deprecated Use config object instead */
  constructor(logger: Logger, alertConfig: ContextTelemetryAlerts);
  constructor(loggerOrConfig: Logger | AnomalyAlertServiceConfig, alertConfig?: ContextTelemetryAlerts) {
    if (typeof (loggerOrConfig as AnomalyAlertServiceConfig).logger !== 'undefined') {
      // New config object style
      const config = loggerOrConfig as AnomalyAlertServiceConfig;
      this.logger = config.logger;
      this.config = config.alertConfig;
      this.cacheRepository = config.cacheRepository;
      this.slackSender = config.slackSender;
    } else {
      // Legacy two-argument style (backward compatible)
      this.logger = loggerOrConfig as Logger;
      this.config = alertConfig!;
    }
  }

  /**
   * Check if Slack alerting is properly configured
   */
  private isSlackConfigured(): boolean {
    return !!(this.config.slackWorkspaceId && this.config.slackChannelId && this.slackSender);
  }

  /**
   * Check if an alert should be sent and send it if appropriate
   * @param telemetry - The context telemetry data
   * @param options - Optional settings for GitHub issue link and recurring status
   */
  async checkAndAlert(telemetry: ContextTelemetry, options?: CheckAndAlertOptions): Promise<boolean> {
    if (!this.config.enabled || !this.isSlackConfigured()) {
      return false;
    }

    const { anomalies } = telemetry;
    const threshold = this.config.alertThreshold ?? ALERT_THRESHOLDS.warning;

    // Check if anomaly score meets threshold
    if (anomalies.anomalyScore < threshold) {
      return false;
    }

    // Check deduplication (distributed or in-memory)
    const isDup = await this.checkDeduplication(anomalies.dedupKey);

    if (isDup) {
      this.logger.info(`📊 [AnomalyAlert] Suppressed duplicate alert: ${anomalies.dedupKey}`);
      return false;
    }

    // Send alert
    try {
      const message = this.formatSlackMessage(telemetry, options);
      await this.sendSlackAlert(message);

      this.logger.info(
        `📊 [AnomalyAlert] Alert sent for ${anomalies.primaryAnomaly} (score: ${anomalies.anomalyScore})`
      );
      return true;
    } catch (error) {
      this.logger.error(`📊 [AnomalyAlert] Failed to send alert:`, error);
      return false;
    }
  }

  /**
   * Check deduplication and claim the key atomically.
   * Uses distributed MongoDB cache when available, falls back to in-memory.
   *
   * @returns true if this is a duplicate (should not send alert), false if we can proceed
   */
  private async checkDeduplication(dedupKey: string): Promise<boolean> {
    const windowMs = (this.config.dedupWindowMinutes ?? 5) * 60 * 1000;
    const cacheKey = `${AnomalyAlertService.DEDUP_KEY_PREFIX}${dedupKey}`;

    // Try distributed dedup first (atomic claim)
    if (this.cacheRepository) {
      try {
        const result = await this.cacheRepository.claimDedup(
          cacheKey,
          { dedupKey, claimedAt: Date.now(), count: 1 },
          windowMs
        );

        // If we claimed it, we can send the alert
        // If someone else claimed it, it's a duplicate
        return !result.claimed;
      } catch (error) {
        // Log but don't fail - fall back to in-memory
        this.logger.warn(`📊 [AnomalyAlert] Distributed dedup failed, using in-memory:`, error);
      }
    }

    // Fall back to in-memory dedup
    return this.checkInMemoryDedup(dedupKey, windowMs);
  }

  /**
   * In-memory deduplication check and record (fallback).
   *
   * LIMITATION: This method is NOT atomic and may allow duplicate alerts in
   * concurrent environments (e.g., multiple Lambda instances). This is acceptable
   * because:
   * 1. The primary distributed dedup (MongoDB claimDedup) is atomic and handles
   *    the vast majority of cases
   * 2. In-memory is only used as a fallback when MongoDB is unavailable
   * 3. In serverless environments, each instance has isolated memory anyway
   * 4. Occasional duplicate alerts are preferable to missing critical alerts
   *
   * For production deployments, ensure MongoDB cacheRepository is configured
   * to get true atomic deduplication across instances.
   */
  private checkInMemoryDedup(dedupKey: string, windowMs: number): boolean {
    const entry = this.dedupCache.get(dedupKey);

    if (entry) {
      const timeSinceLastAlert = Date.now() - entry.lastAlertTime;
      if (timeSinceLastAlert < windowMs) {
        // It's a duplicate
        return true;
      }
    }

    // Not a duplicate - record this alert
    this.recordInMemoryAlert(dedupKey);
    return false;
  }

  /**
   * Record an alert in the in-memory cache
   */
  private recordInMemoryAlert(dedupKey: string): void {
    const existing = this.dedupCache.get(dedupKey);
    this.dedupCache.set(dedupKey, {
      dedupKey,
      lastAlertTime: Date.now(),
      count: (existing?.count ?? 0) + 1,
    });

    // Clean up old entries (older than 1 hour) and enforce max size
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, entry] of this.dedupCache.entries()) {
      if (entry.lastAlertTime < oneHourAgo) {
        this.dedupCache.delete(key);
      }
    }

    // Enforce max cache size to prevent memory leaks
    if (this.dedupCache.size > AnomalyAlertService.MAX_CACHE_ENTRIES) {
      // Remove oldest entries
      const entries = Array.from(this.dedupCache.entries()).sort((a, b) => a[1].lastAlertTime - b[1].lastAlertTime);
      const toRemove = entries.slice(0, this.dedupCache.size - AnomalyAlertService.MAX_CACHE_ENTRIES);
      for (const [key] of toRemove) {
        this.dedupCache.delete(key);
      }
    }
  }

  /**
   * Format telemetry into a Slack Block Kit message
   * @param telemetry - The context telemetry data
   * @param options - Optional settings for GitHub issue link and recurring status
   */
  formatSlackMessage(telemetry: ContextTelemetry, options?: CheckAndAlertOptions): SlackMessage {
    const { anomalies, model, contextWindow, performance, tools, subagents } = telemetry;
    const isCritical = anomalies.anomalyScore >= (this.config.criticalThreshold ?? ALERT_THRESHOLDS.critical);
    const { githubIssueUrl, isRecurring } = options ?? {};

    // Determine emoji and color based on severity
    const emoji = this.getSeverityEmoji(anomalies.severity);
    const severityText = anomalies.severity.toUpperCase();

    // Build the alert title - different for recurring alerts
    const alertType = isRecurring ? 'Recurring Telemetry Alert' : 'Context Telemetry Alert';
    const title = `${emoji} ${alertType}: ${this.formatAnomalyType(anomalies.primaryAnomaly)}`;

    // Build summary text for notification preview
    const summaryText = isRecurring
      ? `${severityText} recurring anomaly (score: ${anomalies.anomalyScore}) - ${anomalies.primaryAnomaly}`
      : `${severityText} anomaly detected (score: ${anomalies.anomalyScore}) - ${anomalies.primaryAnomaly}`;

    const blocks: SlackBlock[] = [
      // Header
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: title,
          emoji: true,
        },
      },
      // Severity and score
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Severity:*\n${emoji} ${severityText}`,
          },
          {
            type: 'mrkdwn',
            text: `*Anomaly Score:*\n${anomalies.anomalyScore}/100`,
          },
          {
            type: 'mrkdwn',
            text: `*Model:*\n${model.modelId}`,
          },
          {
            type: 'mrkdwn',
            text: `*Provider:*\n${model.provider}`,
          },
        ],
      },
      // Divider
      { type: 'divider' },
    ];

    // Anomaly details section
    const anomalyDetails = this.buildAnomalyDetails(anomalies);
    if (anomalyDetails.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Detected Anomalies:*\n${anomalyDetails.join('\n')}`,
        },
      });
    }

    // Context window metrics
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Input Tokens:*\n${contextWindow.inputTokens.toLocaleString()}`,
        },
        {
          type: 'mrkdwn',
          text: `*Utilization:*\n${contextWindow.utilizationPercentage.toFixed(1)}%`,
        },
        {
          type: 'mrkdwn',
          text: `*Response Time:*\n${performance.totalResponseTimeMs.toLocaleString()}ms`,
        },
        {
          type: 'mrkdwn',
          text: `*First Token:*\n${performance.firstTokenTimeMs?.toLocaleString() ?? 'N/A'}ms`,
        },
      ],
    });

    // Tool failures (if any)
    const failedTools = tools?.filter(t => t.failureCount > 0) ?? [];
    if (failedTools.length > 0) {
      const toolDetails = failedTools
        .map(
          t =>
            `• \`${t.toolName}\`: ${t.failureCount} failures${t.lastError ? ` - ${sanitizeTelemetryError(t.lastError, 50)}` : ''}`
        )
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Tool Failures:*\n${toolDetails}`,
        },
      });
    }

    // Subagent timeouts (if any)
    const timedOutAgents = subagents?.filter(s => s.timeoutCount > 0) ?? [];
    if (timedOutAgents.length > 0) {
      const agentDetails = timedOutAgents
        .map(s => `• \`${s.agentName}\`: ${s.timeoutCount} timeouts, ${s.totalDurationMs.toLocaleString()}ms total`)
        .join('\n');
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Subagent Timeouts:*\n${agentDetails}`,
        },
      });
    }

    // Fallback info
    if (model.fallbackUsed) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Fallback Used:*\n${model.originalModelId} → ${model.modelId}\nReason: ${model.fallbackReason ?? 'Unknown'}`,
        },
      });
    }

    // GitHub issue link (if provided)
    if (githubIssueUrl) {
      const issueText = isRecurring
        ? `*Tracked Issue:* This matches an existing issue - <${githubIssueUrl}|View Issue>`
        : `*GitHub Issue:* <${githubIssueUrl}|View Issue>`;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: issueText,
        },
      });
    }

    // Footer with timestamp and dedup key
    blocks.push(
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Timestamp: ${telemetry.timestamp} | Dedup Key: \`${anomalies.dedupKey}\``,
          },
        ],
      }
    );

    // Add @here mention for critical alerts
    if (isCritical) {
      blocks.splice(1, 0, {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '<!here> Critical anomaly requires attention!',
        },
      });
    }

    return {
      text: summaryText,
      blocks,
    };
  }

  /**
   * Build list of detected anomaly details
   */
  private buildAnomalyDetails(anomalies: ContextTelemetry['anomalies']): string[] {
    const details: string[] = [];

    if (anomalies.contextOverflow) {
      details.push('🚨 Context window overflow detected');
    }
    if (anomalies.criticalUtilization) {
      details.push('⚠️ Critical context utilization (≥95%)');
    } else if (anomalies.highUtilization) {
      details.push('⚠️ High context utilization (≥90%)');
    }
    if (anomalies.criticalTruncation) {
      details.push('⚠️ Critical message truncation (≥75%)');
    } else if (anomalies.highTruncation) {
      details.push('⚠️ High message truncation (≥50%)');
    }
    if (anomalies.toolFailureSpike) {
      details.push('🔧 Tool failure spike (≥3 failures)');
    }
    if (anomalies.toolTimeout) {
      details.push('⏱️ Tool timeout detected (>30s)');
    }
    if (anomalies.subagentTimeout) {
      details.push('🤖 Subagent timeout detected (>5min)');
    }
    if (anomalies.slowTotalResponse) {
      details.push('🐌 Slow total response time (>60s)');
    }
    if (anomalies.slowFirstToken) {
      details.push('🐌 Slow first token time (>10s)');
    }

    return details;
  }

  /**
   * Get emoji for severity level
   */
  private getSeverityEmoji(severity: ContextTelemetry['anomalies']['severity']): string {
    switch (severity) {
      case 'critical':
        return '🔴';
      case 'high':
        return '🟠';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      default:
        return '⚪';
    }
  }

  /**
   * Format anomaly type for display
   */
  private formatAnomalyType(type: ContextTelemetry['anomalies']['primaryAnomaly']): string {
    switch (type) {
      case 'context_overflow':
        return 'Context Overflow';
      case 'high_truncation':
        return 'High Truncation';
      case 'tool_failure':
        return 'Tool Failure';
      case 'subagent_timeout':
        return 'Subagent Timeout';
      case 'slow_response':
        return 'Slow Response';
      case 'multiple':
        return 'Multiple Anomalies';
      case 'none':
        return 'Unknown';
      default:
        return type;
    }
  }

  /**
   * Send the formatted message to Slack using the configured sender
   */
  private async sendSlackAlert(message: SlackMessage): Promise<void> {
    if (!this.slackSender || !this.config.slackWorkspaceId || !this.config.slackChannelId) {
      throw new Error('Slack integration not configured');
    }

    await this.slackSender.sendMessage(this.config.slackWorkspaceId, this.config.slackChannelId, message);
  }

  /**
   * Get deduplication statistics for monitoring
   */
  getDedupStats(): { totalEntries: number; recentAlerts: number; distributedDedupEnabled: boolean } {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    const recentAlerts = Array.from(this.dedupCache.values()).filter(e => e.lastAlertTime >= fiveMinutesAgo).length;

    return {
      totalEntries: this.dedupCache.size,
      recentAlerts,
      distributedDedupEnabled: !!this.cacheRepository,
    };
  }
}
