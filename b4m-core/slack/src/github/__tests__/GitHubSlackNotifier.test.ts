import { describe, it, expect, beforeEach, vi } from 'vitest';

// Use vi.hoisted to define mocks before vi.mock hoisting
const {
  mockLogger,
  mockUserFind,
  mockUserFindById,
  mockUserFindOneAndUpdate,
  mockUserFindByIdAndUpdate,
  mockFindAllActiveWithCredentials,
  mockFindByIdWithCredentials,
  mockSendMessage,
  mockFindActiveSubscriberUserIds,
} = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    updateMetadata: vi.fn(),
    withMetadata: vi.fn().mockReturnThis(),
  },
  mockUserFind: vi.fn(),
  mockUserFindById: vi.fn(),
  mockUserFindOneAndUpdate: vi.fn(),
  mockUserFindByIdAndUpdate: vi.fn(),
  mockFindAllActiveWithCredentials: vi.fn(),
  mockFindByIdWithCredentials: vi.fn(),
  mockSendMessage: vi.fn(),
  mockFindActiveSubscriberUserIds: vi.fn(),
}));

vi.mock('../../di/registry', () => ({
  getSlackDb: () => ({
    User: {
      find: (...args: unknown[]) => ({ select: () => mockUserFind(...args) }),
      findById: (...args: unknown[]) => ({ select: () => mockUserFindById(...args) }),
      findOneAndUpdate: mockUserFindOneAndUpdate,
      findByIdAndUpdate: mockUserFindByIdAndUpdate,
    },
    webhookSubscriptionRepository: {
      findActiveSubscriberUserIds: mockFindActiveSubscriberUserIds,
    },
    slackDevWorkspaceRepository: {
      findAllActiveWithCredentials: mockFindAllActiveWithCredentials,
      findByIdWithCredentials: mockFindByIdWithCredentials,
    },
  }),
  getSlackDeps: () => ({
    tokenEncryption: {
      encryptToken: (v: string | null | undefined) => v ?? null,
      decryptToken: (v: string | null | undefined) => v ?? null,
    },
  }),
}));

vi.mock('../../SlackClient', () => ({
  SlackClient: vi.fn().mockImplementation(function () {
    return {
      sendMessage: mockSendMessage,
    };
  }),
}));

import { GitHubSlackNotifier } from '../GitHubSlackNotifier';
import type { Logger } from '@bike4mind/observability';

const buildTestMessage = () => ({
  text: 'Test notification',
  blocks: [],
});

function createMockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    slackSettings: {
      slackUserId: 'U123SLACK',
      githubNotifications: {
        enabled: true,
        githubUsername: 'octocat',
        prOpened: true,
        prReviewRequested: true,
        prApproved: true,
        prChangesRequested: true,
        prMerged: true,
        ciFailed: true,
        ciPassed: false,
        mentions: true,
        channels: {},
        lastNotificationAt: new Date(),
        notificationCount: 0,
      },
    },
    ...overrides,
  };
}

describe('GitHubSlackNotifier', () => {
  let notifier: GitHubSlackNotifier;

  beforeEach(() => {
    vi.clearAllMocks();
    notifier = new GitHubSlackNotifier(mockLogger as unknown as Logger);

    // Default: workspace with bot token
    mockFindAllActiveWithCredentials.mockResolvedValue([{ id: 'ws-1', slackBotToken: 'xoxb-test-token' }]);

    // Default: send succeeds
    mockSendMessage.mockResolvedValue('1234567890.123456');
  });

  describe('notify — user lookup', () => {
    it('should return immediately for empty target list', async () => {
      await notifier.notify('prOpened', [], buildTestMessage);

      expect(mockUserFind).not.toHaveBeenCalled();
    });

    it('should lowercase target usernames before querying', async () => {
      mockUserFind.mockResolvedValue([]);

      await notifier.notify('prOpened', ['OctoCat', 'ALICE'], buildTestMessage);

      expect(mockUserFind).toHaveBeenCalledWith(
        expect.objectContaining({
          'slackSettings.githubNotifications.githubUsername': {
            $in: ['octocat', 'alice'],
          },
        })
      );
    });

    it('should log debug and return when no matching users found', async () => {
      mockUserFind.mockResolvedValue([]);

      await notifier.notify('prOpened', ['nobody'], buildTestMessage);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] No matching users found',
        expect.objectContaining({ usernames: ['nobody'] })
      );
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should return when no bot token available', async () => {
      mockUserFind.mockResolvedValue([createMockUser()]);
      mockFindAllActiveWithCredentials.mockResolvedValue([]);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockLogger.warn).toHaveBeenCalledWith('[GITHUB-NOTIFY] No active Slack workspace with bot token');
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('notifyUser — event filtering', () => {
    it('should skip when event type is disabled by user', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.prOpened = false;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] User has this event type disabled',
        expect.objectContaining({ eventType: 'prOpened' })
      );
    });

    it('should send when event type is not explicitly set (defaults to true)', async () => {
      const user = createMockUser();
      // prOpened is undefined (not explicitly set)
      delete (user.slackSettings.githubNotifications as Record<string, unknown>).prOpened;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalled();
    });
  });

  describe('notifyUser — channel routing', () => {
    it('should use ciAlerts channel for CI events when configured', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.channels = { ciAlerts: 'C-CI-CHANNEL' };
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('ciFailed', ['octocat'], buildTestMessage, { isCI: true });

      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-CI-CHANNEL' }));
    });

    it('should fall back to default channel for CI events when ciAlerts not set', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.channels = { default: 'C-DEFAULT' };
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('ciFailed', ['octocat'], buildTestMessage, { isCI: true });

      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-DEFAULT' }));
    });

    it('should use default channel for non-CI events', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.channels = {
        default: 'C-DEFAULT',
        ciAlerts: 'C-CI-CHANNEL',
      };
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C-DEFAULT' }));
    });

    it('should fall back to DM via slackUserId when no channels configured', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.channels = {};
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'U123SLACK' }));
    });

    it('should skip when no channel and no slackUserId', async () => {
      const user = createMockUser({ slackSettings: { githubNotifications: { enabled: true } } });
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] No channel or Slack user ID for notification',
        expect.any(Object)
      );
    });
  });

  describe('notifyUser — sendMessage result handling', () => {
    it('should log success and record notification when sendMessage succeeds', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockSendMessage.mockResolvedValue('1234567890.123456');
      mockUserFindOneAndUpdate.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockLogger.info).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] Notification sent',
        expect.objectContaining({ userId: 'user-1', eventType: 'prOpened' })
      );
    });

    it('should log error and NOT record notification when sendMessage returns null', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockSendMessage.mockResolvedValue(null);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] Failed to deliver notification to Slack',
        expect.objectContaining({ userId: 'user-1' })
      );
      // Should NOT record notification (no increment)
      expect(mockUserFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('isUnderRateLimit', () => {
    it('should return true when user has no notification history', async () => {
      const user = createMockUser();
      delete (user.slackSettings.githubNotifications as Record<string, unknown>).lastNotificationAt;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockUserFindOneAndUpdate.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('should return true when last notification was yesterday (counter resets)', async () => {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const user = createMockUser();
      user.slackSettings.githubNotifications.lastNotificationAt = yesterday;
      user.slackSettings.githubNotifications.notificationCount = 100;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockUserFindOneAndUpdate.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('should return false when at rate limit today', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.lastNotificationAt = new Date();
      user.slackSettings.githubNotifications.notificationCount = 100;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] Rate limit exceeded',
        expect.objectContaining({ userId: 'user-1' })
      );
    });

    it('should return true when under rate limit today', async () => {
      const user = createMockUser();
      user.slackSettings.githubNotifications.lastNotificationAt = new Date();
      user.slackSettings.githubNotifications.notificationCount = 99;
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockUserFindOneAndUpdate.mockResolvedValue(null);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('should return false when user not found', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(null);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  });

  describe('error isolation', () => {
    it('should continue to next user when one user fails', async () => {
      const user1 = createMockUser({ id: 'user-1' });
      const user2 = createMockUser({ id: 'user-2' });
      mockUserFind.mockResolvedValue([user1, user2]);
      mockUserFindById.mockResolvedValue(user1);
      mockUserFindOneAndUpdate.mockResolvedValue(user1);

      // First call throws, second succeeds
      mockSendMessage.mockRejectedValueOnce(new Error('Slack API error')).mockResolvedValueOnce('1234567890.123456');

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockLogger.error).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] Failed to notify user',
        expect.objectContaining({ userId: 'user-1' })
      );
      // Second user should still be attempted
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
  });

  describe('org subscription filtering', () => {
    it('should NOT send notification when user is found by githubUsername but NOT subscribed to org', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockFindActiveSubscriberUserIds.mockResolvedValue([]); // No subscriptions

      await notifier.notify('prOpened', ['octocat'], buildTestMessage, { orgId: 'org-123' });

      expect(mockFindActiveSubscriberUserIds).toHaveBeenCalledWith('org-123', ['user-1']);
      expect(mockSendMessage).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        '[GITHUB-NOTIFY] No subscribed users for org',
        expect.objectContaining({ orgId: 'org-123' })
      );
    });

    it('should send notification when user IS subscribed to org', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockUserFindOneAndUpdate.mockResolvedValue(user);
      mockFindActiveSubscriberUserIds.mockResolvedValue(['user-1']); // Subscribed

      await notifier.notify('prOpened', ['octocat'], buildTestMessage, { orgId: 'org-123' });

      expect(mockFindActiveSubscriberUserIds).toHaveBeenCalledWith('org-123', ['user-1']);
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('should skip subscription check when no orgId (MCP server path)', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockUserFindOneAndUpdate.mockResolvedValue(user);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(mockFindActiveSubscriberUserIds).not.toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it('should filter to only subscribed users when multiple users match', async () => {
      const user1 = createMockUser({ id: 'user-1' });
      const user2 = createMockUser({ id: 'user-2' });
      mockUserFind.mockResolvedValue([user1, user2]);
      mockUserFindById.mockResolvedValue(user1);
      mockUserFindOneAndUpdate.mockResolvedValue(user1);
      // Only user-1 is subscribed
      mockFindActiveSubscriberUserIds.mockResolvedValue(['user-1']);

      await notifier.notify('prOpened', ['octocat'], buildTestMessage, { orgId: 'org-123' });

      expect(mockFindActiveSubscriberUserIds).toHaveBeenCalledWith('org-123', ['user-1', 'user-2']);
      // Only one user should receive notification
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
  });

  // Notification failures must be reported back, not silently swallowed.
  describe('failure reporting', () => {
    it('returns failedNotifications when sendMessage returns null', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockSendMessage.mockResolvedValue(null);

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.failedNotifications).toHaveLength(1);
      expect(result.failedNotifications[0].userId).toBe('user-1');
      expect(result.failedNotifications[0].error).toMatch(/Slack sendMessage returned no result/);
    });

    it('returns failedNotifications when sendMessage throws', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockUserFindById.mockResolvedValue(user);
      mockSendMessage.mockRejectedValue(new Error('channel_not_found'));

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.failedNotifications).toEqual([{ userId: 'user-1', error: 'channel_not_found' }]);
    });

    it('splits mixed success/failure across users', async () => {
      const user1 = createMockUser({ id: 'user-1' });
      const user2 = createMockUser({ id: 'user-2' });
      mockUserFind.mockResolvedValue([user1, user2]);
      mockUserFindById.mockResolvedValue(user1);
      mockUserFindOneAndUpdate.mockResolvedValue(user1);

      mockSendMessage.mockResolvedValueOnce('1234567890.123456').mockRejectedValueOnce(new Error('rate_limited'));

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual(['user-1']);
      expect(result.failedNotifications).toEqual([{ userId: 'user-2', error: 'rate_limited' }]);
    });

    it('returns dispatchError when User.find throws', async () => {
      mockUserFind.mockRejectedValue(new Error('connection refused'));

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.failedNotifications).toEqual([]);
      expect(result.dispatchError).toMatch(/Target enumeration failed.*connection refused/);
    });

    it('returns dispatchError when subscription check throws (fail-closed)', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockFindActiveSubscriberUserIds.mockRejectedValue(new Error('mongo timeout'));

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage, { orgId: 'org-123' });

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.dispatchError).toMatch(/Subscription check failed.*mongo timeout/);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('returns dispatchError when no Slack workspace is configured', async () => {
      const user = createMockUser();
      mockUserFind.mockResolvedValue([user]);
      mockFindAllActiveWithCredentials.mockResolvedValue([]);

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.dispatchError).toBe('No active Slack workspace with bot token');
    });

    it('does NOT populate failedNotifications for intentionally skipped users', async () => {
      const disabledUser = createMockUser({ id: 'user-1' });
      disabledUser.slackSettings.githubNotifications.prOpened = false;
      mockUserFind.mockResolvedValue([disabledUser]);
      mockUserFindById.mockResolvedValue(disabledUser);

      const result = await notifier.notify('prOpened', ['octocat'], buildTestMessage);

      expect(result.notifiedUserIds).toEqual([]);
      expect(result.failedNotifications).toEqual([]);
      expect(result.dispatchError).toBeUndefined();
    });
  });
});
