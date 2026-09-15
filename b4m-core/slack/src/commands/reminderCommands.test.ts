/**
 * Tests for Reminder Command Handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRemindCommand } from './reminderCommands';
import { B4mCommandContext } from './types';

// Mock SlackClient
vi.mock('../SlackClient', () => ({
  SlackClient: vi.fn().mockImplementation(function () {
    return {
      getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
      addReminder: vi.fn().mockResolvedValue({ id: 'Rm123', text: 'Test', time: 1705881600, user: 'U123' }),
    };
  }),
}));

// Mock reminder-parser
vi.mock('../utils/reminder-parser', () => ({
  parseReminderExpression: vi.fn().mockReturnValue({
    success: true,
    parsed: {
      text: 'check report',
      time: {
        timestamp: 1705881600,
        formatted: 'Mon, Jan 22, 2024 at 9:00 AM PST',
        date: new Date('2024-01-22T17:00:00.000Z'),
      },
    },
  }),
}));

// Mock Logger
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
}));

describe('reminderCommands', () => {
  // Context with user token and reminders scopes (authorized user)
  const mockContext: B4mCommandContext = {
    dbUser: { id: 'user123' } as B4mCommandContext['dbUser'],
    slackUserId: 'U123',
    channelId: 'C123',
    triggerId: 'T123',
    botToken: 'xoxb-test-token',
    userToken: 'xoxp-test-user-token',
    userScopes: ['reminders:write'],
  };

  // Context without user token (unauthorized user)
  const mockContextNoToken: B4mCommandContext = {
    dbUser: { id: 'user123' } as B4mCommandContext['dbUser'],
    slackUserId: 'U123',
    channelId: 'C123',
    triggerId: 'T123',
    botToken: 'xoxb-test-token',
    // No userToken or userScopes
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleRemindCommand - authorization', () => {
    it('should return authorization required when no user token', async () => {
      const result = await handleRemindCommand(['check', 'report', 'tomorrow'], mockContextNoToken);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('additional authorization');
      expect(result.response?.response_type).toBe('ephemeral');
    });

    it('should return authorization required when missing reminders scopes', async () => {
      const contextWithoutScopes = {
        ...mockContext,
        userToken: 'xoxp-test-token',
        userScopes: [], // Missing reminders scopes
      };

      const result = await handleRemindCommand(['check', 'report', 'tomorrow'], contextWithoutScopes);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('additional authorization');
    });
  });

  describe('handleRemindCommand - help', () => {
    it('should return help for empty command (no auth required)', async () => {
      // Help should work without token
      const result = await handleRemindCommand([], mockContextNoToken);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Reminder Commands');
      expect(result.response?.response_type).toBe('ephemeral');
    });

    it('should return help for whitespace-only command', async () => {
      const result = await handleRemindCommand([''], mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Reminder Commands');
    });
  });

  describe('handleRemindCommand - create reminder', () => {
    it('should create reminder successfully', async () => {
      const result = await handleRemindCommand(['check', 'report', 'tomorrow'], mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Reminder set');
    });

    it('should return error for invalid time', async () => {
      const { parseReminderExpression } = await import('../utils/reminder-parser');
      (parseReminderExpression as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        success: false,
        error: "I couldn't understand that time.",
      });

      const result = await handleRemindCommand(['check', 'report', 'asdfghjkl'], mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain("couldn't understand");
    });

    it('should handle API failure', async () => {
      const { SlackClient } = await import('../SlackClient');
      // First call is for botClient (getUserTimezone), second is for userClient (addReminder)
      (SlackClient as unknown as ReturnType<typeof vi.fn>)
        .mockImplementationOnce(function () {
          return {
            getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
          };
        })
        .mockImplementationOnce(function () {
          return {
            addReminder: vi.fn().mockResolvedValue(null),
          };
        });

      const result = await handleRemindCommand(['check', 'report', 'tomorrow'], mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Failed to create');
    });
  });
});
