import { Logger } from '@bike4mind/observability';
import { SlackClient } from '../SlackClient';
import { KnownBlock, Block } from '@slack/web-api';

/**
 * Handle search commands
 *
 * Commands:
 * - /b4m search <query>
 */
export async function handleSearchCommand(
  _dbUser: unknown,
  _slackUserId: string,
  query: string,
  userToken: string | undefined
): Promise<{ text: string; response_type: string; blocks?: (KnownBlock | Block)[] }> {
  if (!query) {
    return {
      text: '❌ Please provide a search query. Usage: `/b4m search <query>`',
      response_type: 'ephemeral',
    };
  }

  if (query.length > 500) {
    return {
      text: '❌ Search query is too long. Please limit to 500 characters.',
      response_type: 'ephemeral',
    };
  }

  if (!userToken) {
    return {
      text: '❌ You need to authorize B4M to search your messages. Please update your Slack app permissions.',
      response_type: 'ephemeral',
    };
  }

  try {
    const slackClient = new SlackClient(userToken, new Logger({ metadata: { component: 'SearchHandler' } }));
    const result = await slackClient.searchMessages(query);

    if (!result || !result.matches || result.matches.length === 0) {
      return {
        text: `🔍 No messages found for "${query}".`,
        response_type: 'ephemeral',
      };
    }

    const matches = result.matches;
    const total = result.total;

    // Format results using Block Kit
    const blocks: (KnownBlock | Block)[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔍 *Search Results for "${query}"* (${total} found)`,
        },
      },
      {
        type: 'divider',
      },
    ];

    for (const match of matches) {
      // Cast match.ts to number because it comes from Slack as a string (e.g. "1623456789.000123")
      const tsNumber = parseFloat(match.ts);
      const date = new Date(tsNumber * 1000).toLocaleString();
      const channelId = match.channel.id;
      const channelName = match.channel.name;
      const permalink = match.permalink;
      const username = match.username;
      const text = match.text.substring(0, 300) + (match.text.length > 300 ? '...' : '');

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${username}* in <#${channelId}|${channelName}> _(${date})_\n${text}`,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'View',
          },
          url: permalink,
          action_id: `view_message_${match.ts}`,
        },
      });
      blocks.push({
        type: 'divider',
      });
    }

    if (total > matches.length) {
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Showing top ${matches.length} results. Refine your query for more specific results.`,
          },
        ],
      });
    }

    return {
      text: `🔍 Search results for "${query}"`,
      blocks,
      response_type: 'ephemeral',
    };
  } catch (error: unknown) {
    // Logger.error is deprecated but we're using it consistently with the codebase for now
    Logger.error('Error searching messages:', error);

    let errorMessage = '❌ Failed to search messages.';
    const slackError = error as { data?: { error?: string } };

    if (slackError.data?.error === 'missing_scope') {
      errorMessage = '❌ App is missing `search:read` scope. Please reinstall the app.';
    } else if (slackError.data?.error === 'not_authed') {
      errorMessage = '❌ User token is invalid or expired. Please unlink and relink your Slack account.';
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}
