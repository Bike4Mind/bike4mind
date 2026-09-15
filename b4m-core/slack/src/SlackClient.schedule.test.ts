/**
 * Tests for SlackClient Schedule Methods
 *
 * Tests scheduleMessage, listScheduledMessages, and deleteScheduledMessage error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from './SlackClient';

// Mock WebClient
const mockWebClient = {
  chat: {
    scheduleMessage: vi.fn(),
    scheduledMessages: {
      list: vi.fn(),
    },
    deleteScheduledMessage: vi.fn(),
  },
  on: vi.fn(),
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return mockWebClient;
  }),
  WebClientEvent: { RATE_LIMITED: 'rate_limited' },
}));

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('SlackClient Schedule Methods', () => {
  let client: SlackClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new SlackClient('xoxb-test-token', mockLogger as unknown as ConstructorParameters<typeof SlackClient>[1]);
  });

  describe('scheduleMessage', () => {
    const validParams = {
      channel: 'C123',
      text: 'Test scheduled message',
      postAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    };

    describe('success cases', () => {
      it('should return scheduled message result on success', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: true,
          scheduled_message_id: 'Q123456',
          post_at: validParams.postAt,
          channel: validParams.channel,
        });

        const result = await client.scheduleMessage(validParams);

        expect(result).not.toBeNull();
        expect(result?.scheduledMessageId).toBe('Q123456');
        expect(result?.postAt).toBe(validParams.postAt);
        expect(result?.channel).toBe(validParams.channel);
      });

      it('should pass threadTs when provided', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: true,
          scheduled_message_id: 'Q123456',
          post_at: validParams.postAt,
        });

        await client.scheduleMessage({
          ...validParams,
          threadTs: '1234567890.123456',
        });

        expect(mockWebClient.chat.scheduleMessage).toHaveBeenCalledWith({
          channel: validParams.channel,
          text: validParams.text,
          post_at: validParams.postAt,
          thread_ts: '1234567890.123456',
        });
      });

      it('should log success message', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: true,
          scheduled_message_id: 'Q123456',
          post_at: validParams.postAt,
        });

        await client.scheduleMessage(validParams);

        expect(mockLogger.info).toHaveBeenCalledWith(
          'Successfully scheduled Slack message',
          expect.objectContaining({
            scheduledMessageId: 'Q123456',
          })
        );
      });
    });

    describe('error handling', () => {
      it('should return null when API returns ok: false', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: false,
          error: 'time_in_past',
        });

        const result = await client.scheduleMessage(validParams);

        expect(result).toBeNull();
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should return null when scheduled_message_id is missing', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: true,
          // Missing scheduled_message_id
        });

        const result = await client.scheduleMessage(validParams);

        expect(result).toBeNull();
      });

      it('should return null and log error when API throws', async () => {
        mockWebClient.chat.scheduleMessage.mockRejectedValue(new Error('Network error'));

        const result = await client.scheduleMessage(validParams);

        expect(result).toBeNull();
        expect(mockLogger.error).toHaveBeenCalledWith('Error scheduling Slack message:', expect.any(Error));
      });

      it('should handle rate limit errors gracefully', async () => {
        const rateLimitError = new Error('rate_limited');
        (rateLimitError as unknown as Record<string, unknown>).code = 'slack_webapi_rate_limited_error';
        mockWebClient.chat.scheduleMessage.mockRejectedValue(rateLimitError);

        const result = await client.scheduleMessage(validParams);

        expect(result).toBeNull();
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should handle invalid_time error', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: false,
          error: 'time_in_past',
        });

        const result = await client.scheduleMessage({
          ...validParams,
          postAt: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        });

        expect(result).toBeNull();
      });

      it('should handle channel_not_found error', async () => {
        mockWebClient.chat.scheduleMessage.mockResolvedValue({
          ok: false,
          error: 'channel_not_found',
        });

        const result = await client.scheduleMessage({
          ...validParams,
          channel: 'INVALID',
        });

        expect(result).toBeNull();
      });
    });
  });

  describe('listScheduledMessages', () => {
    describe('success cases', () => {
      it('should return array of scheduled messages', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: true,
          scheduled_messages: [
            {
              id: 'Q1',
              channel_id: 'C123',
              text: 'Message 1',
              post_at: 1705881600,
              date_created: 1705795200,
            },
            {
              id: 'Q2',
              channel_id: 'C123',
              text: 'Message 2',
              post_at: 1705968000,
              date_created: 1705795200,
            },
          ],
        });

        const result = await client.listScheduledMessages('C123');

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({
          id: 'Q1',
          channel: 'C123',
          text: 'Message 1',
          postAt: 1705881600,
          dateCreated: 1705795200,
        });
      });

      it('should return empty array when no scheduled messages', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: true,
          scheduled_messages: [],
        });

        const result = await client.listScheduledMessages('C123');

        expect(result).toEqual([]);
      });

      it('should work without channel filter', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: true,
          scheduled_messages: [],
        });

        await client.listScheduledMessages();

        expect(mockWebClient.chat.scheduledMessages.list).toHaveBeenCalledWith({
          channel: undefined,
        });
      });
    });

    describe('error handling', () => {
      it('should return empty array when API returns ok: false', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: false,
          error: 'invalid_auth',
        });

        const result = await client.listScheduledMessages('C123');

        expect(result).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalled();
      });

      it('should return empty array when scheduled_messages is missing', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: true,
          // Missing scheduled_messages
        });

        const result = await client.listScheduledMessages('C123');

        expect(result).toEqual([]);
      });

      it('should return empty array and log error when API throws', async () => {
        mockWebClient.chat.scheduledMessages.list.mockRejectedValue(new Error('Network error'));

        const result = await client.listScheduledMessages('C123');

        expect(result).toEqual([]);
        expect(mockLogger.error).toHaveBeenCalledWith('Error listing scheduled Slack messages:', expect.any(Error));
      });

      it('should handle missing fields in scheduled messages gracefully', async () => {
        mockWebClient.chat.scheduledMessages.list.mockResolvedValue({
          ok: true,
          scheduled_messages: [
            {
              // All fields missing/undefined
            },
          ],
        });

        const result = await client.listScheduledMessages('C123');

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          id: '',
          channel: '',
          text: '',
          postAt: 0,
          dateCreated: 0,
        });
      });
    });
  });

  describe('deleteScheduledMessage', () => {
    describe('success cases', () => {
      it('should return true on successful deletion', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({
          ok: true,
        });

        const result = await client.deleteScheduledMessage('C123', 'Q123456');

        expect(result).toBe(true);
        expect(mockLogger.info).toHaveBeenCalledWith(
          'Successfully cancelled scheduled Slack message',
          expect.objectContaining({
            channel: 'C123',
            scheduledMessageId: 'Q123456',
          })
        );
      });

      it('should call API with correct parameters', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({ ok: true });

        await client.deleteScheduledMessage('C123', 'Q123456');

        expect(mockWebClient.chat.deleteScheduledMessage).toHaveBeenCalledWith({
          channel: 'C123',
          scheduled_message_id: 'Q123456',
        });
      });
    });

    describe('error handling', () => {
      it('should return false when API returns ok: false', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({
          ok: false,
          error: 'invalid_scheduled_message_id',
        });

        const result = await client.deleteScheduledMessage('C123', 'INVALID');

        expect(result).toBe(false);
      });

      it('should return false and log error when API throws', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockRejectedValue(new Error('Network error'));

        const result = await client.deleteScheduledMessage('C123', 'Q123456');

        expect(result).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith('Error cancelling scheduled Slack message:', expect.any(Error));
      });

      it('should handle message_not_found error', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({
          ok: false,
          error: 'invalid_scheduled_message_id',
        });

        const result = await client.deleteScheduledMessage('C123', 'NONEXISTENT');

        expect(result).toBe(false);
      });

      it('should handle already_sent error (message was already posted)', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({
          ok: false,
          error: 'bad_scheduled_message_id',
        });

        const result = await client.deleteScheduledMessage('C123', 'Q123456');

        expect(result).toBe(false);
      });

      it('should handle channel_not_found error', async () => {
        mockWebClient.chat.deleteScheduledMessage.mockResolvedValue({
          ok: false,
          error: 'channel_not_found',
        });

        const result = await client.deleteScheduledMessage('INVALID', 'Q123456');

        expect(result).toBe(false);
      });
    });
  });
});
