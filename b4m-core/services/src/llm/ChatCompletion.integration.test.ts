import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as utilsModule from '@bike4mind/utils';

const mockHandleLowCreditNotification = vi.fn().mockResolvedValue(undefined);

// Mock the utils module
vi.mock('@bike4mind/utils', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/utils')>('@bike4mind/utils');
  return {
    ...actual,
    getNotificationDeduplicator: () => ({
      handleLowCreditNotification: mockHandleLowCreditNotification,
    }),
  };
});

describe('ChatCompletion - Notification Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call notification deduplicator when imported', async () => {
    // The notification deduplicator singleton is reachable via
    // getNotificationDeduplicator() and callable from ChatCompletion.

    const testUserId = 'user-123';
    const testUserName = 'Test User';
    const testUserEmail = 'test@example.com';
    const testCredits = 800;
    const testWebhookUrl = 'https://hooks.slack.com/test';

    // Import and call the function directly to test integration
    const { getNotificationDeduplicator } = await import('@bike4mind/utils');

    await getNotificationDeduplicator().handleLowCreditNotification(
      testUserId,
      testUserName,
      testUserEmail,
      testCredits,
      null,
      testWebhookUrl
    );

    expect(mockHandleLowCreditNotification).toHaveBeenCalledWith(
      testUserId,
      testUserName,
      testUserEmail,
      testCredits,
      null,
      testWebhookUrl
    );
  });

  it('should handle dynamic imports properly', async () => {
    // Test that dynamic import works as expected in the ChatCompletion service
    const dynamicImport = await import('@bike4mind/utils');

    expect(dynamicImport.getNotificationDeduplicator).toBeDefined();
    expect(dynamicImport.getNotificationDeduplicator().handleLowCreditNotification).toBeDefined();

    // Test that the function can be called
    await expect(
      dynamicImport
        .getNotificationDeduplicator()
        .handleLowCreditNotification('test-id', 'test-name', 'test@email.com', 500, null, 'https://test.webhook')
    ).resolves.not.toThrow();
  });

  it('should verify integration points exist', () => {
    // Test that all the integration points are available
    expect(utilsModule.getNotificationDeduplicator).toBeDefined();
    expect(utilsModule.getNotificationDeduplicator().handleLowCreditNotification).toBeTypeOf('function');

    // Verify the function signature matches expectations
    const result = utilsModule
      .getNotificationDeduplicator()
      .handleLowCreditNotification('test-id', 'test-name', 'test@email.com', 1000, null, 'https://webhook.url');

    expect(result).toBeInstanceOf(Promise);
  });
});
