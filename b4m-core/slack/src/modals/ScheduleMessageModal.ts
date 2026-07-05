/**
 * Schedule Message Modal Builder
 *
 * Creates a Slack modal for scheduling messages with date/time pickers.
 */

import type { View } from '@slack/web-api';

export const SCHEDULE_MESSAGE_CALLBACK_ID = 'schedule_message_modal';

export interface ScheduleMessageModalParams {
  /** User's timezone to display */
  userTimezone: string;
  /** Channel ID where the message will be scheduled */
  channelId: string;
}

/**
 * Build the Schedule Message modal view
 */
export function buildScheduleMessageModal(params: ScheduleMessageModalParams): View {
  const { userTimezone, channelId } = params;

  return {
    type: 'modal',
    callback_id: SCHEDULE_MESSAGE_CALLBACK_ID,
    private_metadata: JSON.stringify({ channelId }),
    title: {
      type: 'plain_text',
      text: 'Schedule a Message',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Schedule',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    blocks: [
      {
        type: 'input',
        block_id: 'message_block',
        label: {
          type: 'plain_text',
          text: 'Message',
          emoji: true,
        },
        element: {
          type: 'plain_text_input',
          action_id: 'message_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Enter your message...',
          },
        },
      },
      {
        type: 'input',
        block_id: 'date_block',
        label: {
          type: 'plain_text',
          text: 'Date',
          emoji: true,
        },
        element: {
          type: 'datepicker',
          action_id: 'date_input',
          placeholder: {
            type: 'plain_text',
            text: 'Select a date',
          },
        },
      },
      {
        type: 'input',
        block_id: 'time_block',
        label: {
          type: 'plain_text',
          text: 'Time',
          emoji: true,
        },
        element: {
          type: 'timepicker',
          action_id: 'time_input',
          placeholder: {
            type: 'plain_text',
            text: 'Select a time',
          },
        },
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `📍 Timezone: *${userTimezone}*`,
          },
        ],
      },
    ],
  };
}

/**
 * Parse the modal submission values
 */
export interface ScheduleMessageSubmission {
  message: string;
  date: string; // YYYY-MM-DD format
  time: string; // HH:MM format
  channelId: string;
}

export function parseScheduleMessageSubmission(
  values: Record<string, Record<string, { value?: string; selected_date?: string; selected_time?: string }>>,
  privateMetadata: string
): ScheduleMessageSubmission | { error: string } {
  try {
    const message = values.message_block?.message_input?.value;
    const date = values.date_block?.date_input?.selected_date;
    const time = values.time_block?.time_input?.selected_time;
    const { channelId } = JSON.parse(privateMetadata);

    if (!message) {
      return { error: 'Please enter a message.' };
    }

    if (!date) {
      return { error: 'Please select a date.' };
    }

    if (!time) {
      return { error: 'Please select a time.' };
    }

    if (!channelId) {
      return { error: 'Channel information is missing.' };
    }

    return { message, date, time, channelId };
  } catch {
    return { error: 'Failed to parse submission data.' };
  }
}
