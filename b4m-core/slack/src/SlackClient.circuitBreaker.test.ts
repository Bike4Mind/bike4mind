/**
 * Tests for SlackClient circuit breaker integration
 *
 * Verifies that sendMessage and updateMessage respect the circuit breaker
 * and that the circuit breaker failing itself doesn't block Slack calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackClient } from './SlackClient';

// --- Hoisted mocks ---
const { mockIsAvailable } = vi.hoisted(() => ({
  mockIsAvailable: vi.fn(),
}));

vi.mock('./di/registry', () => ({
  getSlackDeps: () => ({
    integrationCircuitBreaker: {
      isAvailable: mockIsAvailable,
    },
  }),
  getSlackDb: () => ({}),
}));

// Mock WebClient
const mockWebClient = {
  chat: {
    postMessage: vi.fn(),
    update: vi.fn(),
    scheduleMessage: vi.fn(),
    scheduledMessages: { list: vi.fn() },
    deleteScheduledMessage: vi.fn(),
  },
  conversations: {
    history: vi.fn(),
  },
  on: vi.fn(),
};

vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return mockWebClient;
  }),
  WebClientEvent: { RATE_LIMITED: 'rate_limited' },
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('SlackClient circuit breaker', () => {
  let client: SlackClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockIsAvailable.mockResolvedValue(true);
    client = new SlackClient('xoxb-test-token', mockLogger as unknown as ConstructorParameters<typeof SlackClient>[1]);
  });

  describe('sendMessage', () => {
    const validParams = {
      channel: 'C123',
      text: 'Hello world',
    };

    it('should send message when circuit breaker allows', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockWebClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      const result = await client.sendMessage(validParams);

      expect(mockIsAvailable).toHaveBeenCalledWith('slack');
      expect(mockWebClient.chat.postMessage).toHaveBeenCalled();
      expect(result).toBe('1234567890.123456');
    });

    it('should return null when circuit breaker blocks', async () => {
      mockIsAvailable.mockResolvedValue(false);

      const result = await client.sendMessage(validParams);

      expect(result).toBeNull();
      expect(mockWebClient.chat.postMessage).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('circuit breaker open'));
    });

    it('should allow call through when circuit breaker itself throws', async () => {
      mockIsAvailable.mockRejectedValue(new Error('DB unavailable'));
      mockWebClient.chat.postMessage.mockResolvedValue({
        ok: true,
        ts: '1234567890.123456',
      });

      const result = await client.sendMessage(validParams);

      // Should still send the message (circuit breaker failure is swallowed)
      expect(mockWebClient.chat.postMessage).toHaveBeenCalled();
      expect(result).toBe('1234567890.123456');
    });
  });

  describe('updateMessage', () => {
    const validParams = {
      channel: 'C123',
      ts: '1234567890.123456',
      text: 'Updated text',
    };

    it('should update message when circuit breaker allows', async () => {
      mockIsAvailable.mockResolvedValue(true);
      mockWebClient.chat.update.mockResolvedValue({ ok: true });

      const result = await client.updateMessage(validParams);

      expect(mockIsAvailable).toHaveBeenCalledWith('slack');
      expect(mockWebClient.chat.update).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return false when circuit breaker blocks (throwOnError=false)', async () => {
      mockIsAvailable.mockResolvedValue(false);

      const result = await client.updateMessage(validParams, false);

      expect(result).toBe(false);
      expect(mockWebClient.chat.update).not.toHaveBeenCalled();
    });

    it('should throw when circuit breaker blocks and throwOnError=true', async () => {
      mockIsAvailable.mockResolvedValue(false);

      await expect(client.updateMessage(validParams, true)).rejects.toThrow(
        'Slack integration is currently unavailable'
      );
      expect(mockWebClient.chat.update).not.toHaveBeenCalled();
    });

    it('should allow call through when circuit breaker itself throws', async () => {
      mockIsAvailable.mockRejectedValue(new Error('DB unavailable'));
      mockWebClient.chat.update.mockResolvedValue({ ok: true });

      const result = await client.updateMessage(validParams);

      expect(mockWebClient.chat.update).toHaveBeenCalled();
      expect(result).toBe(true);
    });
  });
});
