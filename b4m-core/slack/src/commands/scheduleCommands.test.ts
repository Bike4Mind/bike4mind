/**
 * Tests for Schedule Command Handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleB4mCommand, B4mCommandContext } from './scheduleCommands';

// Mock WebClient
vi.mock('@slack/web-api', () => ({
  WebClient: vi.fn().mockImplementation(function () {
    return {
      views: {
        open: vi.fn().mockResolvedValue({ ok: true, view: { id: 'V123' } }),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  }),
}));

// Mock SlackClient
vi.mock('../SlackClient', () => ({
  SlackClient: vi.fn().mockImplementation(function () {
    return {
      getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
      listScheduledMessages: vi.fn().mockResolvedValue([]),
      deleteScheduledMessage: vi.fn().mockResolvedValue(true),
      scheduleMessage: vi.fn().mockResolvedValue({ scheduledMessageId: 'Q123', postAt: 1705881600 }),
    };
  }),
}));

// Mock time-parser
vi.mock('../utils/time-parser', () => ({
  parseAndValidateTime: vi.fn().mockReturnValue({
    success: true,
    parsed: {
      timestamp: 1705881600,
      formatted: 'Mon, Jan 22, 2024 at 9:00 AM PST',
      date: new Date('2024-01-22T17:00:00.000Z'),
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

describe('scheduleCommands', () => {
  const mockContext: B4mCommandContext = {
    dbUser: { id: 'user123' } as B4mCommandContext['dbUser'],
    slackUserId: 'U123',
    channelId: 'C123',
    triggerId: 'T123',
    botToken: 'xoxb-test-token',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleB4mCommand - top level routing', () => {
    it('should return help for empty command', async () => {
      const result = await handleB4mCommand('', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('B4M Commands');
      expect(result.response?.response_type).toBe('ephemeral');
    });

    it('should return help for "help" command', async () => {
      const result = await handleB4mCommand('help', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('B4M Commands');
    });

    it('should route "schedule" to schedule handler', async () => {
      const result = await handleB4mCommand('schedule', mockContext);

      // Should open modal (no args to schedule)
      expect(result.openModal).toBe(true);
    });

    it('should return error for unknown command', async () => {
      const result = await handleB4mCommand('unknown', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Unknown subcommand');
      expect(result.response?.text).toContain('unknown');
      expect(result.response?.response_type).toBe('ephemeral');
    });

    it('should handle commands with extra whitespace', async () => {
      const result = await handleB4mCommand('  help  ', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('B4M Commands');
    });

    it('should be case-insensitive for commands', async () => {
      const result = await handleB4mCommand('HELP', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('B4M Commands');
    });
  });

  describe('handleB4mCommand - schedule subcommands', () => {
    describe('schedule (no args) - modal flow', () => {
      it('should open modal and return openModal: true', async () => {
        const result = await handleB4mCommand('schedule', mockContext);

        expect(result.openModal).toBe(true);
        expect(result.response).toBeUndefined();
      });

      it('should handle modal open failure gracefully', async () => {
        const { WebClient } = await import('@slack/web-api');
        (WebClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            views: {
              open: vi.fn().mockRejectedValue(new Error('trigger_id expired')),
            },
          };
        });

        const result = await handleB4mCommand('schedule', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to open');
        expect(result.response?.response_type).toBe('ephemeral');
      });
    });

    describe('schedule list', () => {
      it('should return empty message when no scheduled messages', async () => {
        const result = await handleB4mCommand('schedule list', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('No scheduled messages');
        expect(result.response?.response_type).toBe('ephemeral');
      });

      it('should list scheduled messages with formatting', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
            listScheduledMessages: vi.fn().mockResolvedValue([
              { id: 'Q1', text: 'Test message 1', postAt: 1705881600 },
              { id: 'Q2', text: 'Test message 2', postAt: 1705968000 },
            ]),
          };
        });

        const result = await handleB4mCommand('schedule list', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Scheduled Messages');
        expect(result.response?.blocks).toBeDefined();
      });

      it('should handle list API failure', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            listScheduledMessages: vi.fn().mockRejectedValue(new Error('API error')),
          };
        });

        const result = await handleB4mCommand('schedule list', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to list');
      });
    });

    describe('schedule cancel', () => {
      it('should return error when message ID is missing', async () => {
        const result = await handleB4mCommand('schedule cancel', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Please provide a message ID');
        expect(result.response?.text).toContain('Usage:');
        expect(result.response?.response_type).toBe('ephemeral');
      });

      it('should cancel message successfully', async () => {
        const result = await handleB4mCommand('schedule cancel Q123456', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('cancelled');
        expect(result.response?.text).toContain('Q123456');
      });

      it('should handle cancel failure (message not found)', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            deleteScheduledMessage: vi.fn().mockResolvedValue(false),
          };
        });

        const result = await handleB4mCommand('schedule cancel Q123456', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to cancel');
        expect(result.response?.text).toContain('may not exist');
      });

      it('should handle cancel API error', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            deleteScheduledMessage: vi.fn().mockRejectedValue(new Error('API error')),
          };
        });

        const result = await handleB4mCommand('schedule cancel Q123456', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to cancel');
      });
    });

    describe('schedule inline - quoted message with time', () => {
      it('should schedule message with double quotes', async () => {
        const result = await handleB4mCommand('schedule "Hello team" tomorrow at 9am', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Message scheduled');
      });

      it('should schedule message with single quotes', async () => {
        const result = await handleB4mCommand("schedule 'Hello team' tomorrow at 9am", mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Message scheduled');
      });

      it('should include message ID in response', async () => {
        const result = await handleB4mCommand('schedule "Test" in 2 hours', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.blocks).toBeDefined();
        // Response should contain the scheduled message ID
        const blockText = JSON.stringify(result.response?.blocks);
        expect(blockText).toContain('Q123');
      });

      it('should return error for invalid time expression', async () => {
        const { parseAndValidateTime } = await import('../utils/time-parser');
        (parseAndValidateTime as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          success: false,
          error: "I couldn't understand that time.",
        });

        const result = await handleB4mCommand('schedule "Test" asdfghjkl', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain("couldn't understand");
      });

      it('should return error for past time', async () => {
        const { parseAndValidateTime } = await import('../utils/time-parser');
        (parseAndValidateTime as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          success: false,
          error: 'That time has already passed.',
        });

        const result = await handleB4mCommand('schedule "Test" yesterday', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('already passed');
      });

      it('should handle schedule API failure', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
            scheduleMessage: vi.fn().mockResolvedValue(null),
          };
        });

        const result = await handleB4mCommand('schedule "Test" tomorrow at 9am', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to schedule');
      });

      it('should handle schedule API error', async () => {
        const { SlackClient } = await import('../SlackClient');
        (SlackClient as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(function () {
          return {
            getUserTimezone: vi.fn().mockResolvedValue('America/Los_Angeles'),
            scheduleMessage: vi.fn().mockRejectedValue(new Error('API error')),
          };
        });

        const result = await handleB4mCommand('schedule "Test" tomorrow at 9am', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Failed to schedule');
      });
    });

    describe('schedule unknown subcommand', () => {
      it('should return error for unknown schedule subcommand', async () => {
        const result = await handleB4mCommand('schedule unknown', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Unknown schedule command');
        expect(result.response?.response_type).toBe('ephemeral');
      });

      it('should return error for malformed input (no quotes)', async () => {
        const result = await handleB4mCommand('schedule hello world tomorrow', mockContext);

        expect(result.response).toBeDefined();
        expect(result.response?.text).toContain('Unknown schedule command');
      });
    });
  });

  describe('malformed input handling', () => {
    it('should handle null-ish command text gracefully', async () => {
      const result = await handleB4mCommand('   ', mockContext);

      expect(result.response).toBeDefined();
      // Empty/whitespace should return help
      expect(result.response?.text).toContain('B4M Commands');
    });

    it('should handle very long command text', async () => {
      const longText = 'schedule ' + 'a'.repeat(10000);
      const result = await handleB4mCommand(longText, mockContext);

      // Should not throw, should return unknown command
      expect(result.response).toBeDefined();
    });

    it('should handle special characters in command', async () => {
      const result = await handleB4mCommand('schedule "Test <script>alert(1)</script>" tomorrow', mockContext);

      // Should still process (XSS is Slack's responsibility to sanitize)
      expect(result.response).toBeDefined();
    });

    it('should handle unicode in message', async () => {
      const result = await handleB4mCommand('schedule "Hello 👋 世界" tomorrow at 9am', mockContext);

      expect(result.response).toBeDefined();
      expect(result.response?.text).toContain('Message scheduled');
    });

    it('should handle newlines in quoted message', async () => {
      // Note: Slack typically strips newlines from slash commands, but test anyway
      const result = await handleB4mCommand('schedule "Line1\nLine2" tomorrow', mockContext);

      expect(result.response).toBeDefined();
    });
  });
});
