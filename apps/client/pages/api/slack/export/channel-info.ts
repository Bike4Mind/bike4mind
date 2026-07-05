import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { decryptToken } from '@server/security/tokenEncryption';
import { isSlackUserValidationError, createSlackExportError } from '@server/integrations/slack/slackExportErrors';

/**
 * Slack Channel Info API
 *
 * Returns channel metadata including estimated message count
 * Used to warn users before exporting large channels
 */

const RequestSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  channelId: z.string().min(1, 'channelId is required'),
});

interface ChannelInfo {
  id: string;
  name: string;
  isPrivate: boolean;
  isArchived: boolean;
  memberCount: number;
  // Note: Slack doesn't provide exact message count, but we can estimate
  // based on the number of messages in recent history
  estimatedMessageCount: number | null;
  oldestMessageTs: string | null;
  latestMessageTs: string | null;
  warning: string | null;
}

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

const FETCH_TIMEOUT = 15000; // 15 seconds

async function fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

/**
 * Estimate message count by sampling the channel history
 * Slack doesn't provide a direct message count API, so we sample
 */
async function estimateMessageCount(
  channelId: string,
  slackBotToken: string
): Promise<{ estimate: number | null; oldestTs: string | null; latestTs: string | null }> {
  try {
    // Fetch a sample of messages to estimate density
    const url = new URL('https://slack.com/api/conversations.history');
    url.searchParams.append('channel', channelId);
    url.searchParams.append('limit', '100'); // Sample size

    const response = await fetchWithTimeout(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        'Content-Type': 'application/json',
      },
    });

    const result = await response.json();

    if (!result.ok) {
      Logger.warn('⚠️ Could not estimate message count', { error: result.error });
      return { estimate: null, oldestTs: null, latestTs: null };
    }

    const messages = result.messages || [];
    if (messages.length === 0) {
      return { estimate: 0, oldestTs: null, latestTs: null };
    }

    const latestTs = messages[0]?.ts || null;
    const oldestInSample = messages[messages.length - 1]?.ts || null;

    // If we got fewer than 100 messages, that's the total
    if (!result.response_metadata?.next_cursor) {
      return {
        estimate: messages.length,
        oldestTs: oldestInSample,
        latestTs,
      };
    }

    // Otherwise, estimate based on message density
    // Calculate time span of our sample
    if (latestTs && oldestInSample) {
      const latestTime = parseFloat(latestTs);
      const oldestTime = parseFloat(oldestInSample);
      const sampleTimeSpan = latestTime - oldestTime;

      if (sampleTimeSpan > 0) {
        // Get the oldest message in the channel
        const oldestUrl = new URL('https://slack.com/api/conversations.history');
        oldestUrl.searchParams.append('channel', channelId);
        oldestUrl.searchParams.append('limit', '1');
        oldestUrl.searchParams.append('oldest', '0');
        oldestUrl.searchParams.append('inclusive', 'true');

        try {
          const oldestResponse = await fetchWithTimeout(oldestUrl.toString(), {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${slackBotToken}`,
              'Content-Type': 'application/json',
            },
          });

          const oldestResult = await oldestResponse.json();
          const channelOldestTs = oldestResult.messages?.[0]?.ts;

          if (channelOldestTs) {
            const totalTimeSpan = latestTime - parseFloat(channelOldestTs);
            // Extrapolate based on density
            const messagesPerSecond = messages.length / sampleTimeSpan;
            const estimate = Math.round(messagesPerSecond * totalTimeSpan);

            return {
              estimate: Math.max(estimate, messages.length), // At least sample size
              oldestTs: channelOldestTs,
              latestTs,
            };
          }
        } catch {
          // Fall back to "unknown large"
        }
      }
    }

    // If we couldn't calculate, indicate it's large (has pagination)
    return {
      estimate: 10000, // Conservative "large channel" indicator
      oldestTs: oldestInSample,
      latestTs,
    };
  } catch (error) {
    Logger.error('❌ Error estimating message count', { error, channelId });
    return { estimate: null, oldestTs: null, latestTs: null };
  }
}

const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const result = RequestSchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { workspaceId, channelId } = result.data;

  Logger.info('🔍 [Slack] Fetching channel info', { workspaceId, channelId });

  // Get workspace with token
  const workspace = await slackDevWorkspaceRepository.findByIdWithToken(workspaceId);
  if (!workspace || !workspace.isActive) {
    throw new BadRequestError('Workspace not found or inactive');
  }

  const slackBotToken = decryptToken(workspace.slackBotToken);
  if (!slackBotToken) {
    throw new BadRequestError('Workspace authentication expired. Please reconnect the workspace.');
  }

  // Fetch channel info from Slack
  const url = new URL('https://slack.com/api/conversations.info');
  url.searchParams.append('channel', channelId);
  url.searchParams.append('include_num_members', 'true');

  const response = await fetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${slackBotToken}`,
      'Content-Type': 'application/json',
    },
  });

  const channelResult = await response.json();

  if (!channelResult.ok) {
    const errorMessages: Record<string, string> = {
      channel_not_found: 'Channel not found. Make sure the bot is added to this channel.',
      not_in_channel: 'Bot is not a member of this channel. Invite the bot first.',
      invalid_auth: 'Workspace authentication expired. Please reconnect.',
      missing_scope: 'Bot missing required permissions. Reinstall the bot.',
    };

    // Use WARN for expected user errors, ERROR for unexpected failures
    if (isSlackUserValidationError(channelResult.error)) {
      Logger.warn('⚠️ Channel info check failed (user error)', {
        error: channelResult.error,
        channelId,
        errorType: 'user_validation',
      });
    } else {
      Logger.error('❌ Channel info check failed', {
        error: channelResult.error,
        channelId,
        errorType: 'system_error',
      });
    }

    throw createSlackExportError(
      errorMessages[channelResult.error] || `Slack error: ${channelResult.error}`,
      channelResult.error
    );
  }

  const channel = channelResult.channel;

  // Estimate message count
  const { estimate, oldestTs, latestTs } = await estimateMessageCount(channelId, slackBotToken);

  // Generate warning based on estimated size
  let warning: string | null = null;
  if (estimate !== null) {
    if (estimate > 50000) {
      warning =
        'This channel has a very large number of messages (50,000+). Export will likely timeout. Please use date range filters to export in smaller batches.';
    } else if (estimate > 10000) {
      warning = 'This channel has many messages (10,000+). Consider using date range filters to avoid timeout issues.';
    } else if (estimate > 5000) {
      warning = 'This channel has a moderate number of messages. Export may take a few minutes.';
    }
  }

  const channelInfo: ChannelInfo = {
    id: channel.id,
    name: channel.name || channel.id,
    isPrivate: channel.is_private || false,
    isArchived: channel.is_archived || false,
    memberCount: channel.num_members || 0,
    estimatedMessageCount: estimate,
    oldestMessageTs: oldestTs,
    latestMessageTs: latestTs,
    warning,
  };

  Logger.info('✅ [Slack] Channel info retrieved', {
    channelId,
    channelName: channelInfo.name,
    estimatedMessages: estimate,
    hasWarning: !!warning,
  });

  return res.json(channelInfo);
});

export default handler;
