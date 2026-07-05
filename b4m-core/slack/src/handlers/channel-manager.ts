import { Logger } from '@bike4mind/observability';
import { SlackClient } from '../SlackClient';

/**
 * Handle channel management commands
 *
 * Commands:
 * - /channel create <name> [private] [topic]
 * - /channel archive <channel_id>
 * - /channel rename <channel_id> <new_name>
 * - /channel topic <channel_id> <topic>
 * - /channel purpose <channel_id> <purpose>
 */
export async function handleChannelCommand(
  dbUser: any, // any: User model from MongoDB - used for permission checks
  slackUserId: string,
  commandText: string,
  slackClient: SlackClient
): Promise<any> {
  // any: Returns a Slack response object (block kit or simple text)
  // Check authorization - only admins can manage channels
  // We check both B4M admin status and Slack admin status (if synced)
  if (!dbUser.isAdmin && !dbUser.slackSettings?.isWorkspaceAdmin) {
    return {
      text: '❌ You do not have permission to manage channels.',
      response_type: 'ephemeral',
    };
  }

  const args = commandText.trim().split(' ');
  const subcommand = args[0]?.toLowerCase();

  switch (subcommand) {
    case '':
    case 'help':
      return getHelpResponse();

    case 'create':
      return await createChannelResponse(dbUser, slackUserId, args.slice(1), slackClient);

    case 'archive':
      return await archiveChannelResponse(args[1], slackClient);

    case 'rename':
      return await renameChannelResponse(args[1], args[2], slackClient);

    case 'topic':
      return await setTopicResponse(args[1], args.slice(2).join(' '), slackClient);

    case 'purpose':
      return await setPurposeResponse(args[1], args.slice(2).join(' '), slackClient);

    default:
      return {
        text: `❓ Unknown subcommand: "${subcommand}". Use \`/channel help\` for available commands.`,
        response_type: 'ephemeral',
      };
  }
}

function getHelpResponse() {
  return {
    text: '📢 Channel Management Commands',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📢 Channel Management Commands*',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '• `/channel create <name> [private]` - Create a new channel (append "private" for private channels)',
            '• `/channel archive <channel_id>` - Archive a channel',
            '• `/channel rename <channel_id> <new_name>` - Rename a channel',
            '• `/channel topic <channel_id> <topic>` - Set channel topic',
            '• `/channel purpose <channel_id> <purpose>` - Set channel purpose',
          ].join('\n'),
        },
      },
    ],
    response_type: 'ephemeral',
  };
}

async function createChannelResponse(dbUser: any, slackUserId: string, args: string[], slackClient: SlackClient) {
  // Parse args: name [private]
  if (args.length === 0) {
    return {
      text: '❌ Please provide a channel name. Usage: `/channel create <name> [private]`',
      response_type: 'ephemeral',
    };
  }

  const name = args[0].toLowerCase();
  const isPrivate = args.includes('private');

  // Validate name (lowercase, max 80 chars, no spaces/invalid chars)
  if (!/^[a-z0-9-_]+$/.test(name)) {
    return {
      text: '❌ Channel names can only contain lowercase letters, numbers, hyphens, and underscores.',
      response_type: 'ephemeral',
    };
  }

  if (name.length > 80) {
    return {
      text: '❌ Channel name must be 80 characters or less.',
      response_type: 'ephemeral',
    };
  }

  try {
    const channel = await slackClient.createChannel(name, isPrivate);

    if (channel) {
      // Auto-invite the creating user
      try {
        await slackClient.inviteToChannel(channel.id, [slackUserId]);
      } catch (inviteError) {
        Logger.warn('Failed to auto-invite user to new channel', {
          channelId: channel.id,
          userId: slackUserId,
          error: inviteError,
        });
        // Don't fail the whole operation if invite fails
      }

      return {
        text: `✅ Created ${isPrivate ? 'private' : 'public'} channel: <#${channel.id}|${channel.name}>`,
        response_type: 'ephemeral',
      };
    } else {
      return {
        text: '❌ Failed to create channel. The name might be taken.',
        response_type: 'ephemeral',
      };
    }
  } catch (error: any) {
    Logger.error('Error creating channel:', error);

    let errorMessage = '❌ Failed to create channel.';
    if (error.data?.error === 'name_taken') {
      errorMessage = `❌ Channel name "${name}" is already taken.`;
    } else if (error.data?.error === 'restricted_action') {
      errorMessage = '❌ You do not have permission to create channels.';
    } else if (error.data?.error === 'missing_scope') {
      errorMessage = '❌ App is missing permissions. Please reinstall the app.';
    } else if (error.data?.error) {
      errorMessage = `❌ Failed to create channel. Error: ${error.data.error}`;
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}

async function archiveChannelResponse(channelId: string, slackClient: SlackClient) {
  if (!channelId) {
    return {
      text: '❌ Please provide a channel ID. Usage: `/channel archive <channel_id>`',
      response_type: 'ephemeral',
    };
  }

  // Clean channel ID (remove <#...|name> formatting if present)
  const cleanId = channelId
    .replace(/^<#/, '')
    .replace(/\|.*>$/, '')
    .replace(/>$/, '');

  try {
    const success = await slackClient.archiveChannel(cleanId);

    if (success) {
      return {
        text: `✅ Channel <#${cleanId}> has been archived.`,
        response_type: 'ephemeral',
      };
    } else {
      return {
        text: `❌ Failed to archive channel <#${cleanId}>.`,
        response_type: 'ephemeral',
      };
    }
  } catch (error: any) {
    Logger.error('Error archiving channel:', error);

    let errorMessage = '❌ Failed to archive channel.';
    if (error.data?.error === 'channel_not_found') {
      errorMessage = '❌ Channel not found.';
    } else if (error.data?.error === 'already_archived') {
      errorMessage = '❌ Channel is already archived.';
    } else if (error.data?.error === 'cant_archive_general') {
      errorMessage = '❌ You cannot archive the #general channel.';
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}

async function renameChannelResponse(channelId: string, newName: string, slackClient: SlackClient) {
  if (!channelId || !newName) {
    return {
      text: '❌ Please provide channel ID and new name. Usage: `/channel rename <channel_id> <new_name>`',
      response_type: 'ephemeral',
    };
  }

  // Clean channel ID
  const cleanId = channelId
    .replace(/^<#/, '')
    .replace(/\|.*>$/, '')
    .replace(/>$/, '');
  const cleanName = newName.toLowerCase();

  if (!/^[a-z0-9-_]+$/.test(cleanName)) {
    return {
      text: '❌ Channel names can only contain lowercase letters, numbers, hyphens, and underscores.',
      response_type: 'ephemeral',
    };
  }

  try {
    const success = await slackClient.renameChannel(cleanId, cleanName);

    if (success) {
      return {
        text: `✅ Channel renamed to #${cleanName}.`,
        response_type: 'ephemeral',
      };
    } else {
      return {
        text: '❌ Failed to rename channel.',
        response_type: 'ephemeral',
      };
    }
  } catch (error: any) {
    Logger.error('Error renaming channel:', error);

    let errorMessage = '❌ Failed to rename channel.';
    if (error.data?.error === 'name_taken') {
      errorMessage = `❌ Channel name "${cleanName}" is already taken.`;
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}

async function setTopicResponse(channelId: string, topic: string, slackClient: SlackClient) {
  if (!channelId || !topic) {
    return {
      text: '❌ Please provide channel ID and topic. Usage: `/channel topic <channel_id> <topic>`',
      response_type: 'ephemeral',
    };
  }

  // Validate topic length (Slack limit: 250 chars)
  if (topic.length > 250) {
    return {
      text: '❌ Topic must be 250 characters or less.',
      response_type: 'ephemeral',
    };
  }

  const cleanId = channelId
    .replace(/^<#/, '')
    .replace(/\|.*>$/, '')
    .replace(/>$/, '');

  try {
    const success = await slackClient.setChannelTopic(cleanId, topic);

    if (success) {
      return {
        text: `✅ Topic set for <#${cleanId}>.`,
        response_type: 'ephemeral',
      };
    } else {
      return {
        text: '❌ Failed to set topic.',
        response_type: 'ephemeral',
      };
    }
  } catch (error: any) {
    Logger.error('Error setting topic:', error);
    let errorMessage = '❌ Failed to set topic.';
    if (error.data?.error === 'too_long') {
      errorMessage = '❌ Topic is too long.';
    } else if (error.data?.error === 'channel_not_found') {
      errorMessage = '❌ Channel not found.';
    } else if (error.data?.error === 'not_in_channel') {
      errorMessage = '❌ Bot must be in the channel to set the topic.';
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}

async function setPurposeResponse(channelId: string, purpose: string, slackClient: SlackClient) {
  if (!channelId || !purpose) {
    return {
      text: '❌ Please provide channel ID and purpose. Usage: `/channel purpose <channel_id> <purpose>`',
      response_type: 'ephemeral',
    };
  }

  // Validate purpose length (Slack limit: 250 chars)
  if (purpose.length > 250) {
    return {
      text: '❌ Purpose must be 250 characters or less.',
      response_type: 'ephemeral',
    };
  }

  const cleanId = channelId
    .replace(/^<#/, '')
    .replace(/\|.*>$/, '')
    .replace(/>$/, '');

  try {
    const success = await slackClient.setChannelPurpose(cleanId, purpose);

    if (success) {
      return {
        text: `✅ Purpose set for <#${cleanId}>.`,
        response_type: 'ephemeral',
      };
    } else {
      return {
        text: '❌ Failed to set purpose.',
        response_type: 'ephemeral',
      };
    }
  } catch (error: any) {
    Logger.error('Error setting purpose:', error);

    let errorMessage = '❌ Failed to set purpose.';
    if (error.data?.error === 'too_long') {
      errorMessage = '❌ Purpose is too long.';
    } else if (error.data?.error === 'channel_not_found') {
      errorMessage = '❌ Channel not found.';
    } else if (error.data?.error === 'not_in_channel') {
      errorMessage = '❌ Bot must be in the channel to set the purpose.';
    }

    return {
      text: errorMessage,
      response_type: 'ephemeral',
    };
  }
}
