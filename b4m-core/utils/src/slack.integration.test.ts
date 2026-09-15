import { describe, it, expect, vi, beforeEach } from 'vitest';
import { notifyEventLogsToSlack } from './slack';
import { CloudWatchLogsEvent } from 'aws-lambda';
import * as zlib from 'node:zlib';

const mockHandleErrorNotification = vi.fn();

vi.mock('./notificationDeduplicator', () => ({
  getNotificationDeduplicator: () => ({
    handleErrorNotification: mockHandleErrorNotification,
  }),
}));

describe('Slack Error Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AWS_REGION = 'us-east-1';
  });

  const createMockCloudWatchEvent = (
    logEvents: Array<{
      id: string;
      timestamp: number;
      message: string;
    }>
  ): CloudWatchLogsEvent => {
    const logData = {
      messageType: 'DATA_MESSAGE',
      owner: '123456789012',
      logGroup: '/aws/lambda/test-function',
      logStream: '2024/01/01/[$LATEST]test-stream',
      subscriptionFilters: ['test-filter'],
      logEvents,
    };

    // Compress and encode the log data like CloudWatch does
    const compressed = zlib.gzipSync(JSON.stringify(logData));
    const encoded = compressed.toString('base64');

    return {
      awslogs: {
        data: encoded,
      },
    };
  };

  describe('Error Log Processing', () => {
    it('should process structured error logs correctly', async () => {
      const structuredErrorMessage =
        '2024-01-01T10:00:00.000Z\trequest-id\tERROR\t{"sessionId":"session-123","method":"GET","path":"/api/test","severity":"error","message":"Database connection failed"}';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-1',
          timestamp: 1704067200000,
          message: structuredErrorMessage,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
        enabledStages: ['production'],
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        'Database connection failed',
        'error',
        expect.objectContaining({
          sessionId: 'session-123',
          method: 'GET',
          path: '/api/test',
          severity: 'error',
          message: 'Database connection failed',
        }),
        expect.objectContaining({
          logGroup: '/aws/lambda/test-function',
          logStream: '2024/01/01/[$LATEST]test-stream',
        }),
        expect.objectContaining({
          id: 'event-1',
          timestamp: 1704067200000,
        }),
        'production',
        'https://hooks.slack.com/test'
      );
    });

    it('should process unstructured error logs with fallback metadata', async () => {
      const rawErrorMessage = 'Unstructured error message from AWS';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-2',
          timestamp: 1704067200000,
          message: rawErrorMessage,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        rawErrorMessage,
        'error',
        { source: 'AWS' },
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
    });

    it('should route throttling exceptions to separate webhook', async () => {
      const throttlingError =
        '2024-01-01T10:00:00.000Z\trequest-id\tERROR\t{"severity":"error","message":"ThrottlingException: Rate exceeded"}';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-3',
          timestamp: 1704067200000,
          message: throttlingError,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/general',
        throttlingSlackUrl: 'https://hooks.slack.com/throttling',
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        'ThrottlingException: Rate exceeded',
        'error',
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/throttling' // Should use throttling webhook
      );
    });

    it('should process multiple log events in batch', async () => {
      const events = [
        {
          id: 'event-1',
          timestamp: 1704067200000,
          message: '2024-01-01T10:00:00.000Z\treq1\tERROR\t{"severity":"error","message":"Error 1"}',
        },
        {
          id: 'event-2',
          timestamp: 1704067201000,
          message: '2024-01-01T10:00:01.000Z\treq2\tWARN\t{"severity":"warn","message":"Warning 1"}',
        },
        {
          id: 'event-3',
          timestamp: 1704067202000,
          message: '2024-01-01T10:00:02.000Z\treq3\tERROR\t{"severity":"error","message":"Error 2"}',
        },
      ];

      const event = createMockCloudWatchEvent(events);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledTimes(3);

      expect(mockHandleErrorNotification).toHaveBeenNthCalledWith(
        1,
        'Error 1',
        'error',
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
      expect(mockHandleErrorNotification).toHaveBeenNthCalledWith(
        2,
        'Warning 1',
        'warn',
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
      expect(mockHandleErrorNotification).toHaveBeenNthCalledWith(
        3,
        'Error 2',
        'error',
        expect.any(Object),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
    });

    it('should skip processing for non-enabled stages', async () => {
      const event = createMockCloudWatchEvent([
        {
          id: 'event-1',
          timestamp: 1704067200000,
          message: 'Test error message',
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'development',
        slackUrl: 'https://hooks.slack.com/test',
        enabledStages: ['production'], // Only production enabled
      });

      expect(mockHandleErrorNotification).not.toHaveBeenCalled();
    });

    it('should handle malformed JSON in log messages gracefully', async () => {
      const malformedMessage = '2024-01-01T10:00:00.000Z\trequest-id\tERROR\t{invalid json}';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-1',
          timestamp: 1704067200000,
          message: malformedMessage,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
      });

      // Should still process but with fallback values
      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        malformedMessage,
        'error',
        { source: 'AWS' },
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
    });

    it('should continue processing other events if one fails', async () => {
      const events = [
        {
          id: 'event-1',
          timestamp: 1704067200000,
          message: '2024-01-01T10:00:00.000Z\treq1\tERROR\t{"severity":"error","message":"Good error"}',
        },
        {
          id: 'event-2',
          timestamp: 1704067201000,
          message: null as any, // This will cause processing to fail
        },
        {
          id: 'event-3',
          timestamp: 1704067202000,
          message: '2024-01-01T10:00:02.000Z\treq3\tERROR\t{"severity":"error","message":"Another good error"}',
        },
      ];

      const event = createMockCloudWatchEvent(events);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
      });

      // Should process the two valid events despite the middle one failing
      expect(mockHandleErrorNotification).toHaveBeenCalledTimes(2);
    });
  });

  describe('Real-world Error Scenarios', () => {
    it('should handle Salesforce API errors correctly', async () => {
      const salesforceError =
        '2024-11-25T00:53:48.462Z\t3377e888-d8cb-4261-9887-d681d2cd556b\tERROR\t{"sessionId":"Root=1-6743ca93-7e4c11143e5cf9251819409d","method":"GET","path":"/api/settings/serverStatus","stage":"pr2608","clientIp":"136.49.141.53","severity":"error","message":"Failed to query Salesforce {\\"error\\":{\\"message\\":\\"Request failed with status code 401\\",\\"name\\":\\"AxiosError\\",\\"stack\\":\\"AxiosError: Request failed with status code 401...\\"}}"}\n';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-sf-1',
          timestamp: 1732496028462,
          message: salesforceError,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/polaris-liveops',
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        expect.stringContaining('Failed to query Salesforce'),
        'error',
        expect.objectContaining({
          sessionId: 'Root=1-6743ca93-7e4c11143e5cf9251819409d',
          method: 'GET',
          path: '/api/settings/serverStatus',
          stage: 'pr2608',
          clientIp: '136.49.141.53',
        }),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/polaris-liveops'
      );
    });

    it('should handle timeout errors', async () => {
      const timeoutError =
        '2024-01-01T10:00:00.000Z\trequest-id\tERROR\t{"severity":"error","message":"Request timeout after 30000ms","requestId":"req-123","endpoint":"/api/heavy-operation"}';

      const event = createMockCloudWatchEvent([
        {
          id: 'event-timeout',
          timestamp: 1704067200000,
          message: timeoutError,
        },
      ]);

      await notifyEventLogsToSlack({
        event,
        stage: 'production',
        slackUrl: 'https://hooks.slack.com/test',
      });

      expect(mockHandleErrorNotification).toHaveBeenCalledWith(
        'Request timeout after 30000ms',
        'error',
        expect.objectContaining({
          requestId: 'req-123',
          endpoint: '/api/heavy-operation',
        }),
        expect.any(Object),
        expect.any(Object),
        'production',
        'https://hooks.slack.com/test'
      );
    });
  });
});
