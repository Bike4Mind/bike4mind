/**
 * Schedule Command Handlers
 *
 * Handles /b4m schedule commands for scheduling Slack messages.
 */

import { WebClient } from '@slack/web-api';
import { Logger } from '@bike4mind/observability';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import { SlackClient } from '../SlackClient';
import { buildScheduleMessageModal } from '../modals/ScheduleMessageModal';
import { parseAndValidateTime } from '../utils/time-parser';
import { handleRemindCommand } from './reminderCommands';
import { handleConfigCommand } from './configCommands';
import { B4mCommandContext, B4mCommandResult } from './types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(advancedFormat);

// Re-export types for backwards compatibility
export type { B4mCommandContext, B4mCommandResult, SlackCommandResponse } from './types';

export async function handleB4mCommand(commandText: string, context: B4mCommandContext): Promise<B4mCommandResult> {
  const args = commandText.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case 'schedule':
      return await handleScheduleCommand(args.slice(1), context);

    case 'remind':
      return await handleRemindCommand(args.slice(1), context);

    case 'config':
      return await handleConfigCommand(context);

    case '':
    case 'help':
      return {
        response: {
          text: '📅 B4M Commands',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text:
                  '*📅 B4M Commands*\n\n' +
                  '*Schedule Messages:*\n' +
                  '• `/b4m schedule` - Open scheduler dialog\n' +
                  '• `/b4m schedule "message" tomorrow at 9am` - Inline\n' +
                  '• `/b4m schedule list` - List scheduled messages\n' +
                  '• `/b4m schedule cancel <id>` - Cancel a message\n\n' +
                  '*Reminders:*\n' +
                  '• `/b4m remind check report tomorrow` - Set reminder\n' +
                  '• View/manage reminders in Slack\'s "Later" tab\n\n' +
                  '*AI Configuration:*\n' +
                  '• `/b4m config` - Show current AI model and system prompt\n\n' +
                  '• `/b4m help` - Show this help',
              },
            },
          ],
          response_type: 'ephemeral',
        },
      };

    default:
      return {
        response: {
          text: `❓ Unknown subcommand: "${subcommand}". Use \`/b4m help\` for available commands.`,
          response_type: 'ephemeral',
        },
      };
  }
}

async function handleScheduleCommand(args: string[], context: B4mCommandContext): Promise<B4mCommandResult> {
  const { slackUserId, channelId, triggerId, botToken } = context;
  const subcommand = args[0]?.toLowerCase();
  const logger = new Logger({ metadata: { component: 'ScheduleCommand' } });

  // /b4m schedule (no args) - open modal
  // IMPORTANT: Open modal immediately without extra API calls to avoid trigger_id expiration (3s limit)
  if (!subcommand || subcommand === '') {
    try {
      const client = new WebClient(botToken);

      // Open the schedule modal immediately with placeholder timezone
      const modal = buildScheduleMessageModal({
        userTimezone: 'loading...',
        channelId,
      });

      const viewResponse = await client.views.open({
        trigger_id: triggerId,
        view: modal,
      });

      // Update modal with the actual timezone in the background (non-blocking).
      if (viewResponse.ok && viewResponse.view?.id) {
        const viewId = viewResponse.view.id;
        const slackClient = new SlackClient(botToken, logger);

        slackClient
          .getUserTimezone(slackUserId)
          .then(async userTimezone => {
            try {
              const updatedModal = buildScheduleMessageModal({
                userTimezone,
                channelId,
              });
              await client.views.update({
                view_id: viewId,
                view: updatedModal,
              });
            } catch (updateError) {
              // Silent fail - modal is already open with placeholder, user can still proceed
              logger.warn('[Slack Command] Failed to update modal with timezone:', updateError);
            }
          })
          .catch(error => {
            // Silent fail - modal is already open with placeholder, user can still proceed
            logger.warn('[Slack Command] Failed to get user timezone:', error);
          });
      }

      return { openModal: true };
    } catch (error) {
      logger.error('[Slack Command] Failed to open schedule modal:', error);
      return {
        response: {
          text: '❌ Failed to open the schedule dialog. Please try again.',
          response_type: 'ephemeral',
        },
      };
    }
  }

  // /b4m schedule list
  if (subcommand === 'list') {
    try {
      const slackClient = new SlackClient(botToken, logger);
      const messages = await slackClient.listScheduledMessages(channelId);

      if (messages.length === 0) {
        return {
          response: {
            text: '📭 No scheduled messages found in this channel.',
            response_type: 'ephemeral',
          },
        };
      }

      // Get user's timezone for proper date formatting
      const userTimezone = await slackClient.getUserTimezone(slackUserId);

      const messageList = messages
        .slice(0, 10)
        .map((msg, i) => {
          const formattedDate = dayjs.unix(msg.postAt).tz(userTimezone).format('ddd, MMM D, YYYY [at] h:mm A z');
          const preview = msg.text.length > 50 ? msg.text.substring(0, 50) + '...' : msg.text;
          return `${i + 1}. *${formattedDate}*\n   "${preview}"\n   ID: \`${msg.id}\``;
        })
        .join('\n\n');

      return {
        response: {
          text: '📅 Scheduled Messages',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*📅 Scheduled Messages*\n\n${messageList}`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `Showing ${Math.min(messages.length, 10)} of ${messages.length} scheduled messages. Use \`/b4m schedule cancel <id>\` to cancel.`,
                },
              ],
            },
          ],
          response_type: 'ephemeral',
        },
      };
    } catch (error) {
      logger.error('[Slack Command] Failed to list scheduled messages:', error);
      return {
        response: {
          text: '❌ Failed to list scheduled messages. Please try again.',
          response_type: 'ephemeral',
        },
      };
    }
  }

  // /b4m schedule cancel <id>
  if (subcommand === 'cancel') {
    const messageId = args[1];
    if (!messageId) {
      return {
        response: {
          text: '❌ Please provide a message ID. Usage: `/b4m schedule cancel <id>`',
          response_type: 'ephemeral',
        },
      };
    }

    try {
      const slackClient = new SlackClient(botToken, logger);
      const success = await slackClient.deleteScheduledMessage(channelId, messageId);

      if (success) {
        return {
          response: {
            text: `✅ Scheduled message \`${messageId}\` has been cancelled.`,
            response_type: 'ephemeral',
          },
        };
      } else {
        return {
          response: {
            text: `❌ Failed to cancel message \`${messageId}\`. It may not exist or has already been sent.`,
            response_type: 'ephemeral',
          },
        };
      }
    } catch (error) {
      logger.error('[Slack Command] Failed to cancel scheduled message:', error);
      return {
        response: {
          text: '❌ Failed to cancel scheduled message. Please try again.',
          response_type: 'ephemeral',
        },
      };
    }
  }

  // /b4m schedule "message" <time expression> - inline scheduling
  // Check if the first arg starts with a quote (inline message)
  const fullText = args.join(' ');
  const quoteMatch = fullText.match(/^["'](.+?)["']\s+(.+)$/);

  if (quoteMatch) {
    const [, message, timeExpression] = quoteMatch;

    try {
      const slackClient = new SlackClient(botToken, logger);
      const userTimezone = await slackClient.getUserTimezone(slackUserId);

      const parseResult = parseAndValidateTime(timeExpression, userTimezone);

      if (!parseResult.success) {
        return {
          response: {
            text: `❌ ${parseResult.error}`,
            response_type: 'ephemeral',
          },
        };
      }

      const result = await slackClient.scheduleMessage({
        channel: channelId,
        text: message,
        postAt: parseResult.parsed.timestamp,
      });

      if (result) {
        return {
          response: {
            text: `✅ Message scheduled for *${parseResult.parsed.formatted}*`,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text:
                    `✅ *Message Scheduled*\n\n` +
                    `📅 *When:* ${parseResult.parsed.formatted}\n` +
                    `💬 *Message:* "${message}"\n` +
                    `🔖 *ID:* \`${result.scheduledMessageId}\``,
                },
              },
              {
                type: 'context',
                elements: [
                  {
                    type: 'mrkdwn',
                    text: `Use \`/b4m schedule cancel ${result.scheduledMessageId}\` to cancel.`,
                  },
                ],
              },
            ],
            response_type: 'ephemeral',
          },
        };
      } else {
        return {
          response: {
            text: '❌ Failed to schedule message. Please try again.',
            response_type: 'ephemeral',
          },
        };
      }
    } catch (error) {
      logger.error('[Slack Command] Failed to schedule inline message:', error);
      return {
        response: {
          text: '❌ Failed to schedule message. Please try again.',
          response_type: 'ephemeral',
        },
      };
    }
  }

  // Unknown schedule subcommand
  return {
    response: {
      text: `❓ Unknown schedule command. Use \`/b4m schedule\` to open the scheduler or \`/b4m help\` for all commands.`,
      response_type: 'ephemeral',
    },
  };
}
