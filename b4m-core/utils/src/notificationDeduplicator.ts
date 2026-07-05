import { Logger } from '@bike4mind/observability';
import { postMessageToSlack } from './slack';

interface DeduplicationEntry {
  count: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
  lastNotificationSent?: Date;
}

/**
 * Balance at which the first low-credit Slack alert fires. Call sites gate on
 * this before invoking handleLowCreditNotification.
 */
export const LOW_CREDIT_ALERT_THRESHOLD = 3000;

interface LowCreditTiers {
  [userId: string]: {
    tierAlert: boolean; // LOW_CREDIT_ALERT_THRESHOLD credits
    tier300: boolean; // 300 credits
    tier0: boolean; // 0 credits
  };
}

export class NotificationDeduplicator {
  private errorGroups = new Map<string, DeduplicationEntry>();
  private lowCreditTiers: LowCreditTiers = {};
  private cleanupTimer?: NodeJS.Timeout;

  private readonly ERROR_GROUPING_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly LOW_CREDIT_RESET_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Schedule the periodic cleanup timer. Safe to call repeatedly; a no-op if
   * already started. The timer is unref'd so it never keeps the Node process
   * alive on its own (important for CLI consumers).
   */
  start(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupOldEntries(), this.CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  /**
   * Clear the periodic cleanup timer. Used by tests and graceful shutdown.
   */
  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  /**
   * Handle low credit notifications with tiered thresholds
   */
  async handleLowCreditNotification(
    userId: string,
    username: string,
    email: string,
    currentCredits: number,
    organization?: { id: string; name: string } | null,
    slackWebhookUrl?: string
  ): Promise<void> {
    if (!slackWebhookUrl) return;

    if (!this.lowCreditTiers[userId]) {
      this.lowCreditTiers[userId] = { tierAlert: false, tier300: false, tier0: false };
    }

    const userTiers = this.lowCreditTiers[userId];
    let shouldNotify = false;
    let tierMessage = '';

    // Check which tier threshold is crossed and not yet notified
    if (currentCredits <= 0 && !userTiers.tier0) {
      userTiers.tier0 = true;
      shouldNotify = true;
      tierMessage = '🚨 *CRITICAL* - User has run out of credits!';
    } else if (currentCredits <= 300 && !userTiers.tier300) {
      userTiers.tier300 = true;
      shouldNotify = true;
      tierMessage = '⚠️ *WARNING* - User credits critically low (≤300)';
    } else if (currentCredits <= LOW_CREDIT_ALERT_THRESHOLD && !userTiers.tierAlert) {
      userTiers.tierAlert = true;
      shouldNotify = true;
      tierMessage = `⚠️ *Low Credits Alert* - User credits below ${LOW_CREDIT_ALERT_THRESHOLD}`;
    }

    if (shouldNotify) {
      const message = `${tierMessage}\n*User:* ${username} (${email})\n*User ID:* ${userId}\n*Current Credits:* ${currentCredits}${
        organization ? `\n*Organization:* ${organization.name} (${organization.id})` : ''
      }`;

      await postMessageToSlack(slackWebhookUrl, message);
      Logger.info(`Sent tiered low credit notification for user ${userId} at ${currentCredits} credits`);
    }

    // Reset tiers if credits are restored above thresholds
    if (currentCredits > LOW_CREDIT_ALERT_THRESHOLD) {
      userTiers.tierAlert = false;
      userTiers.tier300 = false;
      userTiers.tier0 = false;
    } else if (currentCredits > 300) {
      userTiers.tier300 = false;
      userTiers.tier0 = false;
    } else if (currentCredits > 0) {
      userTiers.tier0 = false;
    }
  }

  /**
   * Handle error notifications with deduplication and grouping
   */
  async handleErrorNotification(
    errorMessage: string,
    severity: string,
    metadata: Record<string, string>,
    logData: any,
    logEvent: any,
    stage: string,
    slackUrl: string
  ): Promise<void> {
    const normalizedError = this.normalizeErrorMessage(errorMessage);
    const groupKey = `${severity}:${normalizedError}`;

    const now = new Date();
    const existingEntry = this.errorGroups.get(groupKey);

    if (!existingEntry) {
      this.errorGroups.set(groupKey, {
        count: 1,
        firstOccurrence: now,
        lastOccurrence: now,
        lastNotificationSent: now,
      });

      await this.sendErrorNotification(errorMessage, severity, metadata, logData, logEvent, stage, slackUrl, 1);
    } else {
      existingEntry.count++;
      existingEntry.lastOccurrence = now;

      // Send another notification only after the grouping window
      const timeSinceLastNotification = now.getTime() - (existingEntry.lastNotificationSent?.getTime() || 0);

      if (timeSinceLastNotification >= this.ERROR_GROUPING_WINDOW_MS) {
        await this.sendErrorNotification(
          errorMessage,
          severity,
          metadata,
          logData,
          logEvent,
          stage,
          slackUrl,
          existingEntry.count,
          existingEntry.firstOccurrence,
          existingEntry.lastOccurrence
        );
        existingEntry.lastNotificationSent = now;
      }
    }
  }

  private async sendErrorNotification(
    message: string,
    severity: string,
    metadata: Record<string, string>,
    logData: any,
    logEvent: any,
    stage: string,
    slackUrl: string,
    count: number,
    firstOccurrence?: Date,
    lastOccurrence?: Date
  ): Promise<void> {
    const tags = Object.entries(metadata)
      .map(([key, value]) => `\`${key}: ${value}\``)
      .join(' ');

    const group = encodeURIComponent(logData.logGroup);
    const stream = encodeURIComponent(logData.logStream);
    const url = `https://console.aws.amazon.com/cloudwatch/home?region=${process.env.AWS_REGION}#logEventViewer:group=${group};stream=${stream};start=${logEvent.timestamp};end=${logEvent.timestamp}`;

    let slackMessage: string;

    if (count === 1) {
      slackMessage = `*${severity.toUpperCase()}* - ${message}\n\`env: ${stage}\` ${tags} [AWS](${url})`;
    } else {
      const duration =
        lastOccurrence && firstOccurrence
          ? this.formatDuration(lastOccurrence.getTime() - firstOccurrence.getTime())
          : '';

      slackMessage = `*${severity.toUpperCase()}* - ${message}\n\`count: ${count}\` \`duration: ${duration}\` \`env: ${stage}\` ${tags} [AWS](${url})`;
    }

    await postMessageToSlack(slackUrl, slackMessage);
  }

  private normalizeErrorMessage(message: string): string {
    // Remove timestamps, request IDs, and other variable data
    return message
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z/g, '[TIMESTAMP]')
      .replace(/Request failed with status code \d+/g, 'Request failed with status code [CODE]')
      .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g, '[UUID]')
      .replace(/\b\d+\.\d+\.\d+\.\d+\b/g, '[IP]')
      .substring(0, 200); // Limit length for grouping
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  private cleanupOldEntries(): void {
    const cutoffTime = Date.now() - this.CLEANUP_INTERVAL_MS;

    for (const [key, entry] of Array.from(this.errorGroups.entries())) {
      if (entry.lastOccurrence.getTime() < cutoffTime) {
        this.errorGroups.delete(key);
      }
    }
  }

  /**
   * Get current deduplication status (for monitoring)
   */
  getStatus() {
    return {
      errorGroupsCount: this.errorGroups.size,
      lowCreditUsersTracked: Object.keys(this.lowCreditTiers).length,
    };
  }
}

let _instance: NotificationDeduplicator | null = null;

/**
 * Lazily construct (and start the cleanup timer for) the shared
 * NotificationDeduplicator singleton. Callers that never invoke this never
 * pay the cost of the periodic cleanup timer - important for CLI / script
 * consumers that import `@bike4mind/utils` for unrelated helpers.
 */
export function getNotificationDeduplicator(): NotificationDeduplicator {
  if (!_instance) {
    _instance = new NotificationDeduplicator();
    _instance.start();
  }
  return _instance;
}

/** Reset the singleton between tests. Not for production use. */
export function __resetNotificationDeduplicatorForTesting(): void {
  if (_instance) {
    _instance.stop();
    _instance = null;
  }
}
