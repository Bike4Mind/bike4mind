import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NotificationDeduplicator,
  getNotificationDeduplicator,
  __resetNotificationDeduplicatorForTesting,
} from './notificationDeduplicator';
import * as slackModule from './slack';

vi.mock('./slack', () => ({
  postMessageToSlack: vi.fn(),
}));

vi.mock('./logger', () => ({
  Logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('NotificationDeduplicator', () => {
  let deduplicator: NotificationDeduplicator;
  let mockPostMessageToSlack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPostMessageToSlack = vi.mocked(slackModule.postMessageToSlack);
    deduplicator = new NotificationDeduplicator();
  });

  afterEach(() => {
    deduplicator.stop();
    __resetNotificationDeduplicatorForTesting();
    vi.clearAllTimers();
  });

  describe('Low Credit Notifications', () => {
    const testUser = {
      userId: 'user-123',
      username: 'testuser',
      email: 'test@example.com',
    };

    const mockOrg = { id: 'org-123', name: 'Test Org' };
    const webhookUrl = 'https://hooks.slack.com/test';

    it('should send notification for first time below 3000 credits', async () => {
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        2500,
        mockOrg,
        webhookUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledOnce();
      expect(mockPostMessageToSlack).toHaveBeenCalledWith(
        webhookUrl,
        expect.stringContaining('⚠️ *Low Credits Alert* - User credits below 3000')
      );
    });

    it('should not send duplicate notifications for same tier', async () => {
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        800,
        mockOrg,
        webhookUrl
      );

      // Same tier, so no second notification
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        700,
        mockOrg,
        webhookUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledOnce();
    });

    it('should send escalated notification for lower tier (300 credits)', async () => {
      // First: 3000 tier
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        800,
        mockOrg,
        webhookUrl
      );

      // Second: 300 tier
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        200,
        mockOrg,
        webhookUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledTimes(2);
      expect(mockPostMessageToSlack).toHaveBeenNthCalledWith(
        2,
        webhookUrl,
        expect.stringContaining('⚠️ *WARNING* - User credits critically low (≤300)')
      );
    });

    it('should send critical notification at 0 credits', async () => {
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        0,
        mockOrg,
        webhookUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledWith(
        webhookUrl,
        expect.stringContaining('🚨 *CRITICAL* - User has run out of credits!')
      );
    });

    it('should reset tiers when credits are restored above 3000', async () => {
      // Trigger all tiers
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        0,
        mockOrg,
        webhookUrl
      );
      // Reset with high credits
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        3500,
        mockOrg,
        webhookUrl
      );
      // Should trigger again when going below 3000
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        800,
        mockOrg,
        webhookUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledTimes(2); // Initial 0 credits + reset trigger
    });

    it('should handle missing webhook URL gracefully', async () => {
      await deduplicator.handleLowCreditNotification(
        testUser.userId,
        testUser.username,
        testUser.email,
        500,
        mockOrg,
        undefined
      );

      expect(mockPostMessageToSlack).not.toHaveBeenCalled();
    });
  });

  describe('Error Notification Deduplication', () => {
    const mockLogData = {
      logGroup: '/aws/lambda/test-function',
      logStream: '2024/01/01/test-stream',
    };

    const mockLogEvent = {
      id: 'event-123',
      timestamp: 1704067200000,
      message: 'test message',
    };

    const mockMetadata = { sessionId: 'session-123', method: 'GET' };
    const stage = 'production';
    const slackUrl = 'https://hooks.slack.com/errors';

    beforeEach(() => {
      process.env.AWS_REGION = 'us-east-1';
    });

    it('should send notification for first error occurrence', async () => {
      await deduplicator.handleErrorNotification(
        'Database connection failed',
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledOnce();
      expect(mockPostMessageToSlack).toHaveBeenCalledWith(
        slackUrl,
        expect.stringContaining('*ERROR* - Database connection failed')
      );
    });

    it('should not send duplicate notifications within time window', async () => {
      const errorMessage = 'Database connection failed';

      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      // Second occurrence, should be deduplicated
      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledOnce();
    });

    it('should send grouped notification after time window', async () => {
      vi.useFakeTimers();
      const errorMessage = 'Database connection failed';

      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      // Multiple occurrences within window
      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );
      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      // Advance time by 6 minutes (beyond 5-minute window)
      vi.advanceTimersByTime(6 * 60 * 1000);

      // Another occurrence - should trigger grouped notification
      await deduplicator.handleErrorNotification(
        errorMessage,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledTimes(2);
      expect(mockPostMessageToSlack).toHaveBeenNthCalledWith(2, slackUrl, expect.stringContaining('`count: 4`'));

      vi.useRealTimers();
    });

    it('should normalize similar error messages', async () => {
      const error1 = 'Request failed with status code 401 at 2024-01-01T10:00:00.000Z';
      const error2 = 'Request failed with status code 401 at 2024-01-01T11:00:00.000Z'; // Same error, different timestamp

      // These should be grouped together (timestamps normalized)
      await deduplicator.handleErrorNotification(
        error1,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );
      await deduplicator.handleErrorNotification(
        error2,
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledOnce();
    });

    it('should handle different error types separately', async () => {
      await deduplicator.handleErrorNotification(
        'Database error',
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      await deduplicator.handleErrorNotification(
        'Authentication error',
        'error',
        mockMetadata,
        mockLogData,
        mockLogEvent,
        stage,
        slackUrl
      );

      expect(mockPostMessageToSlack).toHaveBeenCalledTimes(2);
    });
  });

  describe('Status and Cleanup', () => {
    it('should return current status', () => {
      const status = deduplicator.getStatus();
      expect(status).toHaveProperty('errorGroupsCount');
      expect(status).toHaveProperty('lowCreditUsersTracked');
      expect(typeof status.errorGroupsCount).toBe('number');
      expect(typeof status.lowCreditUsersTracked).toBe('number');
    });

    it('should track error groups and users correctly', async () => {
      // Add some error entries
      await deduplicator.handleErrorNotification(
        'Error 1',
        'error',
        { test: 'data' },
        { logGroup: 'test', logStream: 'test' },
        { id: '1', timestamp: Date.now(), message: 'test' },
        'test',
        'http://test.com'
      );

      await deduplicator.handleLowCreditNotification(
        'user-1',
        'Test User',
        'test@example.com',
        500,
        null,
        'http://webhook.com'
      );

      const status = deduplicator.getStatus();
      expect(status.errorGroupsCount).toBe(1);
      expect(status.lowCreditUsersTracked).toBe(1);
    });
  });

  describe('Lifecycle (start/stop)', () => {
    it('constructor does not start the cleanup timer', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const d = new NotificationDeduplicator();
      expect(setIntervalSpy).not.toHaveBeenCalled();
      d.stop();
      setIntervalSpy.mockRestore();
    });

    it('start() schedules a cleanup timer that is unref-ed', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const d = new NotificationDeduplicator();
      d.start();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      d.stop();
      setIntervalSpy.mockRestore();
    });

    it('start() is idempotent', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const d = new NotificationDeduplicator();
      d.start();
      d.start();
      d.start();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      d.stop();
      setIntervalSpy.mockRestore();
    });

    it('stop() clears the timer and allows start() to schedule again', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      const d = new NotificationDeduplicator();
      d.start();
      d.stop();
      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      d.start();
      d.stop();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
      clearIntervalSpy.mockRestore();
    });
  });

  describe('getNotificationDeduplicator (lazy singleton)', () => {
    it('does not construct or start a timer on module import', () => {
      // Importing this file imports the module; a side-effecting module would
      // already have a running timer. Reset here so no singleton leaks into the
      // next test, which verifies lazy construction.
      __resetNotificationDeduplicatorForTesting();
    });

    it('lazily creates the singleton on first call and starts its timer', () => {
      __resetNotificationDeduplicatorForTesting();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');

      const first = getNotificationDeduplicator();
      expect(setIntervalSpy).toHaveBeenCalledOnce();

      const second = getNotificationDeduplicator();
      expect(second).toBe(first);
      expect(setIntervalSpy).toHaveBeenCalledOnce(); // still only one timer

      setIntervalSpy.mockRestore();
    });
  });
});
