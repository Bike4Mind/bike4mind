/**
 * Reminder Command Handlers
 *
 * Handles /b4m remind commands for creating Slack reminders.
 *
 * IMPORTANT: The Slack Reminders API requires USER tokens (xoxp-*), not bot tokens.
 * Users must authorize with 'reminders:write' scope via OAuth.
 *
 * NOTE: Slack deprecated the reminders.list, reminders.info, reminders.delete, and
 * reminders.complete API endpoints in March 2023. Only reminders.add still works.
 * See: https://api.slack.com/changelog/2023-07-its-later-already-for-the-reminders-apis
 */

import { Logger } from '@bike4mind/observability';
import { SlackClient } from '../SlackClient';
import { SLACK_USER_SCOPES } from '../user-link-helpers';
import { parseReminderExpression } from '../utils/reminder-parser';
import { B4mCommandContext, B4mCommandResult } from './types';

/**
 * Check if user has required scopes for reminders
 */
function hasRemindersScopes(userScopes?: string[]): boolean {
  if (!userScopes || userScopes.length === 0) return false;
  return SLACK_USER_SCOPES.every(scope => userScopes.includes(scope));
}

/**
 * Build authorization required response with link to re-authorize
 */
function buildAuthorizationRequiredResponse(): B4mCommandResult {
  return {
    response: {
      text: '🔐 Reminders require additional authorization',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*🔐 Authorization Required*\n\n' +
              'To use reminders, B4M needs permission to manage your Slack reminders.\n\n' +
              'Please re-link your Slack account in the B4M app home tab to authorize.',
          },
        },
      ],
      response_type: 'ephemeral',
    },
  };
}

/**
 * Handle /b4m remind subcommands
 */
export async function handleRemindCommand(args: string[], context: B4mCommandContext): Promise<B4mCommandResult> {
  const { slackUserId, botToken, userToken, userScopes } = context;
  const subcommand = args[0]?.toLowerCase();
  const logger = new Logger({ metadata: { component: 'ReminderCommand' } });

  logger.debug('🔔 [Remind Command] Checking authorization', {
    slackUserId,
    hasUserToken: !!userToken,
    hasRemindersScopes: hasRemindersScopes(userScopes),
    subcommand: subcommand || 'help',
  });

  // /b4m remind (no args) - show help
  if (!subcommand || subcommand === '') {
    return {
      response: {
        text: '🔔 Reminder Commands',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                '*🔔 Reminder Commands*\n\n' +
                '*Create a reminder:*\n' +
                '• `/b4m remind check report tomorrow at 9am`\n' +
                '• `/b4m remind "call mom" in 2 hours`\n' +
                '• `/b4m remind to review PR next Monday`\n\n' +
                '_Reminders will appear in your Slack "Later" tab and notify you at the scheduled time._',
            },
          },
        ],
        response_type: 'ephemeral',
      },
    };
  }

  // Check for user token and scopes
  if (!userToken || !hasRemindersScopes(userScopes)) {
    logger.debug('🔐 [Remind Command] Authorization required', {
      reason: !userToken ? 'no_user_token' : 'missing_scopes',
    });
    return buildAuthorizationRequiredResponse();
  }

  // Parse as a reminder creation
  const fullText = args.join(' ');
  return await handleReminderCreate(fullText, slackUserId, userToken, botToken, logger);
}

/**
 * Create a new reminder
 *
 * @param input - User's reminder text and time expression
 * @param slackUserId - Slack user ID for timezone lookup
 * @param userToken - User's OAuth token for reminders API
 * @param botToken - Bot token for timezone lookup (users.info requires bot token)
 * @param logger - Logger instance
 */
async function handleReminderCreate(
  input: string,
  slackUserId: string,
  userToken: string,
  botToken: string,
  logger: Logger
): Promise<B4mCommandResult> {
  try {
    // Use bot token for timezone lookup (users.info works with bot token)
    const botClient = new SlackClient(botToken, logger);
    const userTimezone = await botClient.getUserTimezone(slackUserId);

    const parseResult = parseReminderExpression(input, userTimezone);

    if (!parseResult.success) {
      return {
        response: {
          text: `❌ ${parseResult.error}`,
          response_type: 'ephemeral',
        },
      };
    }

    const { text, time } = parseResult.parsed;

    // Use user token for reminders API (requires user token, not bot token)
    const userClient = new SlackClient(userToken, logger);
    const result = await userClient.addReminder(text, time.timestamp, slackUserId);

    if (result) {
      return {
        response: {
          text: `✅ Reminder set for *${time.formatted}*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `✅ *Reminder Set*\n\n` + `🔔 *What:* ${text}\n` + `📅 *When:* ${time.formatted}`,
              },
            },
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `_You'll receive a notification in Slack at the scheduled time. View your reminders in Slack's "Later" tab._`,
                },
              ],
            },
          ],
          response_type: 'ephemeral',
        },
      };
    } else {
      logger.error('🔔 [Remind Create] Slack API returned failure', {
        input,
        slackUserId,
        text: text.substring(0, 50),
      });
      return {
        response: {
          text: '❌ Failed to create reminder. The Slack API returned an error. Try re-linking your Slack account in the B4M app home tab.',
          response_type: 'ephemeral',
        },
      };
    }
  } catch (error) {
    logger.error('🔔 [Remind Create] Error creating reminder', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      input,
      slackUserId,
    });

    // Check for specific Slack API errors
    const slackError = error as { data?: { error?: string } };
    if (slackError?.data?.error === 'token_revoked' || slackError?.data?.error === 'invalid_auth') {
      return buildAuthorizationRequiredResponse();
    }
    if (slackError?.data?.error === 'ratelimited') {
      return {
        response: {
          text: '⏳ Too many requests. Please wait a moment and try again.',
          response_type: 'ephemeral',
        },
      };
    }

    return {
      response: {
        text: '❌ Failed to create reminder. If this persists, try re-linking your Slack account in the B4M app home tab.',
        response_type: 'ephemeral',
      },
    };
  }
}
