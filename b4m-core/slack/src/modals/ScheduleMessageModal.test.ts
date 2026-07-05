/**
 * Tests for Schedule Message Modal
 */

import { describe, it, expect } from 'vitest';
import {
  buildScheduleMessageModal,
  parseScheduleMessageSubmission,
  SCHEDULE_MESSAGE_CALLBACK_ID,
} from './ScheduleMessageModal';

describe('ScheduleMessageModal', () => {
  describe('buildScheduleMessageModal', () => {
    it('should build a valid modal view', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'America/Los_Angeles',
        channelId: 'C12345',
      });

      expect(modal.type).toBe('modal');
      expect(modal.callback_id).toBe(SCHEDULE_MESSAGE_CALLBACK_ID);
      // Cast to access modal-specific properties
      const modalView = modal as { title?: { type: string; text: string; emoji?: boolean } };
      expect(modalView.title).toEqual({
        type: 'plain_text',
        text: 'Schedule a Message',
        emoji: true,
      });
    });

    it('should include channelId in private_metadata', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'America/Los_Angeles',
        channelId: 'C12345',
      });

      const metadata = JSON.parse(modal.private_metadata || '{}');
      expect(metadata.channelId).toBe('C12345');
    });

    it('should display user timezone in context block', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'Europe/London',
        channelId: 'C12345',
      });

      const contextBlock = modal.blocks?.find((block: { type: string }) => block.type === 'context');
      expect(contextBlock).toBeDefined();
      expect(JSON.stringify(contextBlock)).toContain('Europe/London');
    });

    it('should include message input block', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'America/Los_Angeles',
        channelId: 'C12345',
      });

      const messageBlock = modal.blocks?.find((block: { block_id?: string }) => block.block_id === 'message_block');
      expect(messageBlock).toBeDefined();
      expect(messageBlock?.type).toBe('input');
    });

    it('should include date picker block', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'America/Los_Angeles',
        channelId: 'C12345',
      });

      const dateBlock = modal.blocks?.find((block: { block_id?: string }) => block.block_id === 'date_block');
      expect(dateBlock).toBeDefined();
    });

    it('should include time picker block', () => {
      const modal = buildScheduleMessageModal({
        userTimezone: 'America/Los_Angeles',
        channelId: 'C12345',
      });

      const timeBlock = modal.blocks?.find((block: { block_id?: string }) => block.block_id === 'time_block');
      expect(timeBlock).toBeDefined();
    });
  });

  describe('parseScheduleMessageSubmission', () => {
    const validValues = {
      message_block: {
        message_input: { value: 'Test message' },
      },
      date_block: {
        date_input: { selected_date: '2024-01-20' },
      },
      time_block: {
        time_input: { selected_time: '14:00' },
      },
    };

    const validMetadata = JSON.stringify({ channelId: 'C12345' });

    describe('successful parsing', () => {
      it('should parse valid submission data', () => {
        const result = parseScheduleMessageSubmission(validValues, validMetadata);

        expect('error' in result).toBe(false);
        if (!('error' in result)) {
          expect(result.message).toBe('Test message');
          expect(result.date).toBe('2024-01-20');
          expect(result.time).toBe('14:00');
          expect(result.channelId).toBe('C12345');
        }
      });
    });

    describe('validation errors', () => {
      it('should return error when message is missing', () => {
        const values = {
          ...validValues,
          message_block: { message_input: { value: undefined } },
        };

        const result = parseScheduleMessageSubmission(values, validMetadata);

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Please enter a message.');
        }
      });

      it('should return error when message is empty string', () => {
        const values = {
          ...validValues,
          message_block: { message_input: { value: '' } },
        };

        const result = parseScheduleMessageSubmission(values, validMetadata);

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Please enter a message.');
        }
      });

      it('should return error when date is missing', () => {
        const values = {
          ...validValues,
          date_block: { date_input: { selected_date: undefined } },
        };

        const result = parseScheduleMessageSubmission(values, validMetadata);

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Please select a date.');
        }
      });

      it('should return error when time is missing', () => {
        const values = {
          ...validValues,
          time_block: { time_input: { selected_time: undefined } },
        };

        const result = parseScheduleMessageSubmission(values, validMetadata);

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Please select a time.');
        }
      });

      it('should return error when channelId is missing from metadata', () => {
        const result = parseScheduleMessageSubmission(validValues, JSON.stringify({}));

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Channel information is missing.');
        }
      });

      it('should return error when private_metadata is invalid JSON', () => {
        const result = parseScheduleMessageSubmission(validValues, 'not-valid-json');

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Failed to parse submission data.');
        }
      });

      it('should return error when private_metadata is empty string', () => {
        const result = parseScheduleMessageSubmission(validValues, '');

        expect('error' in result).toBe(true);
        if ('error' in result) {
          expect(result.error).toBe('Failed to parse submission data.');
        }
      });
    });

    describe('edge cases', () => {
      it('should handle missing block structures gracefully', () => {
        const values = {};

        const result = parseScheduleMessageSubmission(
          values as Record<string, Record<string, { value?: string }>>,
          validMetadata
        );

        expect('error' in result).toBe(true);
      });

      it('should handle null-like values in blocks', () => {
        const values = {
          message_block: null,
          date_block: null,
          time_block: null,
        };

        const result = parseScheduleMessageSubmission(
          values as unknown as Record<string, Record<string, { value?: string }>>,
          validMetadata
        );

        expect('error' in result).toBe(true);
      });
    });
  });
});
