/**
 * GitHubSlackNotifier - core notification engine for GitHub -> Slack.
 *
 * Responsibilities:
 *   1. Determine target GitHub usernames from event data
 *   2. Look up users with matching githubUsername + enabled notifications
 *   3. Filter by per-event preference
 *   4. Rate-limit (100 notifications/day per user, atomic $inc)
 *   5. Resolve channel (custom channel or DM via slackUserId)
 *   6. Build Block Kit message via template
 *   7. Send via SlackClient
 */

import { extractErrorMessage } from '@bike4mind/utils';
import { Logger } from '@bike4mind/observability';
import { SlackClient } from '../SlackClient';
import { KnownBlock } from '@slack/web-api';
import { getSlackDb, getSlackDeps } from '../di/registry';

const MAX_NOTIFICATIONS_PER_DAY = 100;

export type GitHubNotificationEventType =
  | 'prOpened'
  | 'prReviewRequested'
  | 'prApproved'
  | 'prChangesRequested'
  | 'prMerged'
  | 'ciFailed'
  | 'ciPassed'
  | 'mentions'
  | 'pushCommits'
  | 'issueOpened'
  | 'issueClosed'
  | 'issueAssigned'
  | 'prReviewComment';

interface NotificationPayload {
  text: string;
  blocks: KnownBlock[];
}

/**
 * Result returned by `GitHubSlackNotifier.notify()`.
 *
 * Distinguishes three populations of users:
 * - `notifiedUserIds`: Slack message confirmed delivered
 * - `failedNotifications`: attempted but failed (Slack API threw or returned !ok)
 *
 * `dispatchError` is set when notification couldn't be attempted at all
 * (target enumeration failed, subscription check failed, no Slack workspace,
 * bot token fetch failed). In that case, downstream callers should surface
 * the failure for observability rather than treating zero notifications as
 * "no targets matched."
 *
 * Users intentionally skipped (event-type pref disabled, rate-limited, no
 * channel) appear in neither list - they are not failures.
 */
export interface NotifyResult {
  notifiedUserIds: string[];
  failedNotifications: Array<{ userId: string; error: string }>;
  dispatchError?: string;
}

type NotifyUserOutcome = { kind: 'sent' } | { kind: 'skipped' } | { kind: 'failed'; error: string };

export class GitHubSlackNotifier {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Send a notification to specific GitHub users for a given event type.
   * Returns notification outcome split into delivered, failed, and (optionally)
   * a pre-loop dispatch error. Never throws - all failures surface via the result.
   */
  async notify(
    eventType: GitHubNotificationEventType,
    targetGitHubUsernames: string[],
    buildMessage: (user: { slackUserId?: string }) => NotificationPayload,
    options?: { isCI?: boolean; orgId?: string }
  ): Promise<NotifyResult> {
    if (targetGitHubUsernames.length === 0) {
      return { notifiedUserIds: [], failedNotifications: [] };
    }

    // Lowercase GitHub usernames for case-insensitive matching
    const usernames = targetGitHubUsernames.map(u => u.toLowerCase());

    // Resolve DI inside try/catch so DI/init bugs surface as `dispatchError` rather
    // than throwing - preserves the "never throws" contract on this method.
    let User: unknown;
    let webhookSubscriptionRepository: unknown;
    try {
      const db = getSlackDb();
      User = db.User;
      webhookSubscriptionRepository = db.webhookSubscriptionRepository;
    } catch (error) {
      const message = extractErrorMessage(error);
      this.logger.error('[GITHUB-NOTIFY] Failed to resolve Slack DB dependencies', { eventType, error });
      return {
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: `DI resolution failed: ${message}`,
      };
    }

    // Find users that have this GitHub username AND enabled notifications
    let users: Array<{ id: string; slackSettings?: unknown }>;
    try {
      users = await (User as any)
        .find({
          'slackSettings.githubNotifications.githubUsername': {
            $in: usernames,
          },
          'slackSettings.githubNotifications.enabled': true,
        })
        .select('slackSettings.slackUserId slackSettings.githubNotifications');
    } catch (error) {
      const message = extractErrorMessage(error);
      this.logger.error('[GITHUB-NOTIFY] Failed to enumerate notification targets', {
        usernames,
        eventType,
        error,
      });
      return {
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: `Target enumeration failed: ${message}`,
      };
    }

    if (users.length === 0) {
      this.logger.debug('[GITHUB-NOTIFY] No matching users found', { usernames, eventType });
      return { notifiedUserIds: [], failedNotifications: [] };
    }

    // When orgId is present (org webhook path), filter to only users with an active subscription.
    // This is NOT redundant with the queue handler's subscriber validation. The queue handler
    // validates "subscribers" (users who opted in to receive an org's webhook events); this
    // checks "notification targets" (users whose githubUsername appears in the payload, e.g. a
    // PR reviewer). These are different populations - a subscriber might not be a notification
    // target, and vice versa. This check prevents non-subscribers from receiving notifications.
    if (options?.orgId && users.length > 0) {
      try {
        const userIds = users.map((u: any) => u.id);
        const subscribedUserIds = await (webhookSubscriptionRepository as any).findActiveSubscriberUserIds(
          options.orgId,
          userIds
        );
        const subscribedSet = new Set(subscribedUserIds);
        const preFilterCount = users.length;
        users = users.filter((u: any) => subscribedSet.has(u.id));

        if (users.length < preFilterCount) {
          this.logger.debug('[GITHUB-NOTIFY] Filtered non-subscribed users', {
            orgId: options.orgId,
            preFilterCount,
            postFilterCount: users.length,
            eventType,
          });
        }

        if (users.length === 0) {
          this.logger.debug('[GITHUB-NOTIFY] No subscribed users for org', {
            orgId: options.orgId,
            eventType,
          });
          return { notifiedUserIds: [], failedNotifications: [] };
        }
      } catch (error) {
        // Fail-closed: don't send notifications when we can't verify subscriptions.
        // Surface as dispatch error so the queue handler records this as Failed
        // rather than silently dropping deliveries to Skipped.
        const message = extractErrorMessage(error);
        this.logger.error('[GITHUB-NOTIFY] Failed to check subscription status, skipping notifications', {
          orgId: options.orgId,
          error,
          userCount: users.length,
          eventType,
        });
        return {
          notifiedUserIds: [],
          failedNotifications: [],
          dispatchError: `Subscription check failed: ${message}`,
        };
      }
    }

    // Get workspace bot token
    let botToken: string | null;
    try {
      botToken = await this.getBotToken();
    } catch (error) {
      const message = extractErrorMessage(error);
      this.logger.error('[GITHUB-NOTIFY] Failed to fetch Slack bot token', { eventType, error });
      return {
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: `Bot token fetch failed: ${message}`,
      };
    }

    if (!botToken) {
      this.logger.warn('[GITHUB-NOTIFY] No active Slack workspace with bot token');
      return {
        notifiedUserIds: [],
        failedNotifications: [],
        dispatchError: 'No active Slack workspace with bot token',
      };
    }

    const slackClient = new SlackClient(botToken, this.logger);
    const notifiedUserIds: string[] = [];
    const failedNotifications: Array<{ userId: string; error: string }> = [];

    for (const user of users) {
      try {
        const outcome = await this.notifyUser(user as never, eventType, buildMessage, slackClient, options);
        if (outcome.kind === 'sent') {
          notifiedUserIds.push(user.id);
        } else if (outcome.kind === 'failed') {
          failedNotifications.push({ userId: user.id, error: outcome.error });
        }
        // 'skipped' is intentional - no-op
      } catch (error) {
        const message = extractErrorMessage(error);
        this.logger.error('[GITHUB-NOTIFY] Failed to notify user', {
          userId: user.id,
          eventType,
          error,
        });
        failedNotifications.push({ userId: user.id, error: message });
      }
    }

    return { notifiedUserIds, failedNotifications };
  }

  /**
   * Attempt to notify a single user. Returns a tagged outcome:
   *   - 'sent'    - message was delivered
   *   - 'skipped' - user is intentionally not notified (pref disabled,
   *                 rate-limited, no channel configured)
   *   - 'failed'  - Slack send was attempted but did not succeed
   */
  private async notifyUser(
    user: {
      id: string;
      slackSettings?: {
        slackUserId?: string;
        githubNotifications?: {
          enabled: boolean;
          prOpened?: boolean;
          prReviewRequested?: boolean;
          prApproved?: boolean;
          prChangesRequested?: boolean;
          prMerged?: boolean;
          ciFailed?: boolean;
          ciPassed?: boolean;
          mentions?: boolean;
          // New event types
          pushCommits?: boolean;
          issueOpened?: boolean;
          issueClosed?: boolean;
          issueAssigned?: boolean;
          prReviewComment?: boolean;
          channels?: { default?: string; ciAlerts?: string };
          lastNotificationAt?: Date;
          notificationCount?: number;
        };
      };
    },
    eventType: GitHubNotificationEventType,
    buildMessage: (user: { slackUserId?: string }) => NotificationPayload,
    slackClient: SlackClient,
    options?: { isCI?: boolean }
  ): Promise<NotifyUserOutcome> {
    const prefs = user.slackSettings?.githubNotifications;
    if (!prefs?.enabled) return { kind: 'skipped' };

    // Check per-event preference (defaults to true for most, false for ciPassed)
    // Use type assertion for dynamic event type indexing since not all types are in IUserPreferences
    if ((prefs as unknown as Record<string, boolean | undefined>)[eventType] === false) {
      this.logger.debug('[GITHUB-NOTIFY] User has this event type disabled', {
        userId: user.id,
        eventType,
      });
      return { kind: 'skipped' };
    }

    // Rate limit check (read-only, no increment)
    if (!(await this.isUnderRateLimit(user.id))) {
      this.logger.warn('[GITHUB-NOTIFY] Rate limit exceeded', { userId: user.id });
      return { kind: 'skipped' };
    }

    // Resolve channel: CI alerts channel -> default channel -> DM
    let channel: string | undefined;
    if (options?.isCI && prefs.channels?.ciAlerts) {
      channel = prefs.channels.ciAlerts;
    } else if (prefs.channels?.default) {
      channel = prefs.channels.default;
    } else {
      channel = user.slackSettings?.slackUserId;
    }

    if (!channel) {
      this.logger.debug('[GITHUB-NOTIFY] No channel or Slack user ID for notification', {
        userId: user.id,
      });
      return { kind: 'skipped' };
    }

    const { text, blocks } = buildMessage({ slackUserId: user.slackSettings?.slackUserId });

    const result = await slackClient.sendMessage({ channel, text, blocks });

    if (result) {
      try {
        await this.recordNotification(user.id);
      } catch (recordError) {
        this.logger.error('[GITHUB-NOTIFY] Failed to record notification (message was sent)', {
          userId: user.id,
          eventType,
          error: recordError,
        });
      }
      this.logger.info('[GITHUB-NOTIFY] Notification sent', {
        userId: user.id,
        eventType,
        channel,
      });
      return { kind: 'sent' };
    }

    this.logger.error('[GITHUB-NOTIFY] Failed to deliver notification to Slack', {
      userId: user.id,
      eventType,
      channel,
    });
    return { kind: 'failed', error: `Slack sendMessage returned no result for channel ${channel}` };
  }

  /**
   * Read-only rate limit check. Returns true if user is under the daily limit.
   */
  private async isUnderRateLimit(userId: string): Promise<boolean> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { User } = getSlackDb();
    const user = (await (User as any)
      .findById(userId)
      .select(
        'slackSettings.githubNotifications.lastNotificationAt slackSettings.githubNotifications.notificationCount'
      )) as {
      slackSettings?: {
        githubNotifications?: { lastNotificationAt?: Date; notificationCount?: number };
      };
    } | null;
    if (!user) return false;

    const prefs = user.slackSettings?.githubNotifications;
    if (!prefs?.lastNotificationAt || prefs.lastNotificationAt < todayStart) {
      // Counter is stale (from a previous day) - treat as 0
      return true;
    }

    return (prefs.notificationCount ?? 0) < MAX_NOTIFICATIONS_PER_DAY;
  }

  /**
   * Increment notification counter after a successful send.
   * Resets daily counter when lastNotificationAt is before today.
   */
  private async recordNotification(userId: string): Promise<void> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const { User } = getSlackDb();
    // Try to reset counter if it's a new day
    const resetResult = await (User as any).findOneAndUpdate(
      {
        _id: userId,
        $or: [
          { 'slackSettings.githubNotifications.lastNotificationAt': { $lt: todayStart } },
          { 'slackSettings.githubNotifications.lastNotificationAt': { $exists: false } },
        ],
      },
      {
        $set: {
          'slackSettings.githubNotifications.notificationCount': 1,
          'slackSettings.githubNotifications.lastNotificationAt': new Date(),
        },
      }
    );

    if (!resetResult) {
      // Already counted today - atomically increment only if under limit
      await (User as any).findOneAndUpdate(
        {
          _id: userId,
          'slackSettings.githubNotifications.notificationCount': { $lt: MAX_NOTIFICATIONS_PER_DAY },
        },
        {
          $inc: { 'slackSettings.githubNotifications.notificationCount': 1 },
          $set: { 'slackSettings.githubNotifications.lastNotificationAt': new Date() },
        }
      );
    }
  }

  /**
   * Get bot token from first active Slack workspace.
   */
  private async getBotToken(): Promise<string | null> {
    const { slackDevWorkspaceRepository } = getSlackDb();
    const workspaces = await (slackDevWorkspaceRepository as any).findAllActiveWithCredentials();
    if (workspaces.length === 0) return null;

    const workspace = workspaces[0];
    // findAllActiveWithCredentials includes +slackBotToken in some queries
    // but we need to fetch it explicitly if not included
    const { decryptToken } = getSlackDeps().tokenEncryption;
    if (workspace.slackBotToken) {
      return decryptToken(workspace.slackBotToken);
    }

    // Fetch with bot token explicitly
    const workspaceWithToken = await (slackDevWorkspaceRepository as any).findByIdWithCredentials(workspace.id);
    return decryptToken(workspaceWithToken?.slackBotToken) || null;
  }
}
