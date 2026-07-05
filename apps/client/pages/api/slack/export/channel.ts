import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { Logger } from '@bike4mind/observability';
import { z } from 'zod';
import { slackDevWorkspaceRepository } from '@bike4mind/database';
import { decryptToken } from '@server/security/tokenEncryption';
import pLimit from 'p-limit';
import {
  isSlackUserValidationError,
  isSlackUserValidationErrorByMessage,
  createSlackExportError,
} from '@server/integrations/slack/slackExportErrors';

/**
 * Slack Channel Export API
 *
 * Exports complete channel history with pagination support
 */

const ExportRequestSchema = z.object({
  workspaceId: z.string().min(1, 'workspaceId is required'),
  channelId: z.string().min(1, 'channelId is required'),
  dateRange: z
    .object({
      start: z.iso.datetime().optional(),
      end: z.iso.datetime().optional(),
    })
    .optional(),
  includeThreads: z.boolean().prefault(true),
  includeUserNames: z.boolean().prefault(true),
  format: z.enum(['json', 'csv', 'markdown']).prefault('json'),
});

// Safety limits to prevent memory issues
const MAX_MESSAGES = 50000; // Hard cap on message count
const MAX_EXPORT_TIME = 5 * 60 * 1000; // 5 minutes max
const FETCH_TIMEOUT = 30000; // 30 seconds per API call

interface SlackMessage {
  ts: string;
  user?: string;
  user_name?: string;
  text: string;
  thread_ts?: string;
  replies?: SlackMessage[];
  attachments?: any[];
}

interface ExportWarning {
  phase: string;
  message: string;
  details?: string;
  timestamp: string;
}

interface ExportStats {
  messages_fetched: number;
  threads_fetched: number;
  thread_replies_fetched: number;
  users_resolved: number;
  users_failed: number;
  duration_ms: number;
}

interface ExportResult {
  channel: {
    id: string;
    name?: string;
  };
  exported_at: string;
  message_count: number;
  messages: SlackMessage[];
  // New fields for enhanced feedback
  export_status: 'complete' | 'partial' | 'failed';
  warnings?: ExportWarning[];
  stats?: ExportStats;
  error?: {
    message: string;
    phase: string;
    suggestion: string;
  };
}

const ensureAdmin = (isAdmin?: boolean | null) => {
  if (!isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }
};

/**
 * Translate Slack API error codes to user-friendly messages with suggestions
 */
function getSlackErrorInfo(errorCode: string): { message: string; suggestion: string } {
  const errorInfo: Record<string, { message: string; suggestion: string }> = {
    channel_not_found: {
      message: 'Channel not found or bot is not a member.',
      suggestion: 'Invite the bot to the channel first using /invite @YourBotName in Slack.',
    },
    not_in_channel: {
      message: 'Bot is not a member of this channel.',
      suggestion: 'In Slack, go to the channel and type /invite @YourBotName to add the bot.',
    },
    invalid_auth: {
      message: 'Workspace authentication has expired.',
      suggestion: 'Go to Admin → Slack Workspaces and reconnect your workspace.',
    },
    account_inactive: {
      message: 'Slack workspace is inactive or suspended.',
      suggestion: 'Contact your Slack workspace administrator to reactivate the workspace.',
    },
    token_revoked: {
      message: 'Bot token has been revoked.',
      suggestion: 'The bot was removed from Slack. Reinstall by going to Admin → Slack Workspaces → Install.',
    },
    missing_scope: {
      message: 'Bot is missing required permissions.',
      suggestion:
        'Reinstall the bot with these scopes: channels:history, groups:history, im:history, mpim:history, channels:read, users:read',
    },
    is_archived: {
      message: 'This channel has been archived.',
      suggestion: 'Unarchive the channel in Slack settings if you need to export it, or try a different channel.',
    },
    ekm_access_denied: {
      message: 'Enterprise Key Management restrictions prevent access.',
      suggestion: 'Contact your Slack Enterprise admin to grant EKM access for this channel.',
    },
    not_authed: {
      message: 'No authentication token provided.',
      suggestion: 'Try refreshing the page and logging in again. If persistent, reconnect the Slack workspace.',
    },
    invalid_arguments: {
      message: 'Invalid request parameters.',
      suggestion: 'Check that the channel ID is correct (format: C01234ABCDE) and date range is valid.',
    },
    request_timeout: {
      message: 'Slack API request timed out.',
      suggestion: 'The channel may be very large. Try using a narrower date range to export in smaller batches.',
    },
    ratelimited: {
      message: 'Slack rate limit exceeded.',
      suggestion: 'Wait a few minutes and try again. For large exports, consider using date range filtering.',
    },
    fatal_error: {
      message: 'Slack API encountered an internal error.',
      suggestion: 'Wait a few minutes and try again. Check status.slack.com if the issue persists.',
    },
    internal_error: {
      message: 'Slack API encountered an internal error.',
      suggestion: 'Wait a few minutes and try again. Check status.slack.com if the issue persists.',
    },
  };

  return (
    errorInfo[errorCode] || {
      message: `Slack API error: ${errorCode}`,
      suggestion: 'Please contact support if this error persists.',
    }
  );
}

/**
 * Simple message getter for backwards compatibility
 */
function getSlackErrorMessage(errorCode: string): string {
  return getSlackErrorInfo(errorCode).message;
}

/**
 * Fetch with timeout and retry logic for Slack rate limits
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Add timeout using AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle Slack rate limiting
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '60');
        Logger.warn('⚠️ Rate limited by Slack API', {
          retryAfter,
          attempt: attempt + 1,
          maxRetries,
        });

        if (attempt < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          continue;
        }
      }

      if (!response.ok && response.status !== 429) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${FETCH_TIMEOUT / 1000}s`);
      }

      if (attempt === maxRetries - 1) {
        throw error;
      }

      // Exponential backoff for other errors
      const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
      Logger.warn('⚠️ Fetch error, retrying', {
        error: error.message,
        attempt: attempt + 1,
        backoffMs: backoff,
      });
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }

  throw new Error('Max retries exceeded');
}

/**
 * Fetch all messages from a channel with pagination
 */
async function fetchAllMessages(
  channelId: string,
  slackBotToken: string,
  dateRange?: { start?: string; end?: string }
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  // Convert date range to Slack timestamps (Unix epoch in seconds)
  const oldest = dateRange?.start ? new Date(dateRange.start).getTime() / 1000 : undefined;
  const latest = dateRange?.end ? new Date(dateRange.end).getTime() / 1000 : undefined;

  while (hasMore) {
    try {
      const url = new URL('https://slack.com/api/conversations.history');
      url.searchParams.append('channel', channelId);
      url.searchParams.append('limit', '1000');
      if (cursor) url.searchParams.append('cursor', cursor);
      if (oldest) url.searchParams.append('oldest', oldest.toString());
      if (latest) url.searchParams.append('latest', latest.toString());

      const response = await fetchWithRetry(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          'Content-Type': 'application/json',
        },
      });

      const result = await response.json();

      if (result.ok && result.messages) {
        messages.push(...(result.messages as SlackMessage[]));
        cursor = result.response_metadata?.next_cursor;
        hasMore = Boolean(cursor);

        Logger.info('📥 Fetched messages batch', {
          channel: channelId,
          batchSize: result.messages.length,
          totalSoFar: messages.length,
          hasMore,
        });

        // Safety check: prevent memory bomb
        if (messages.length >= MAX_MESSAGES) {
          Logger.warn('⚠️ Hit maximum message limit', {
            limit: MAX_MESSAGES,
            channel: channelId,
          });
          throw new BadRequestError(
            `Channel too large (${messages.length}+ messages). Please use date range filtering to export smaller batches.`
          );
        }
      } else {
        // Use WARN for expected user errors, ERROR for unexpected failures
        if (isSlackUserValidationError(result.error)) {
          Logger.warn('⚠️ Channel access issue (user error)', {
            error: result.error,
            channelId,
            errorType: 'user_validation',
          });
        } else {
          Logger.error('❌ Failed to fetch messages', {
            error: result.error,
            errorType: 'system_error',
          });
        }
        // Use createSlackExportError to preserve error code in additionalInfo
        throw createSlackExportError(getSlackErrorMessage(result.error), result.error);
      }
    } catch (error: any) {
      // Check if this is a user validation error (from createSlackExportError)
      const slackErrorCode = error.additionalInfo?.slackErrorCode;
      const isUserError = slackErrorCode
        ? isSlackUserValidationError(slackErrorCode)
        : isSlackUserValidationErrorByMessage(error.message);

      if (isUserError) {
        Logger.warn('⚠️ Error fetching channel history (user error)', {
          error: error.message || error,
          channelId,
          slackErrorCode,
          errorType: 'user_validation',
        });
      } else {
        Logger.error('❌ Error fetching channel history', {
          error,
          channelId,
          errorType: 'system_error',
        });
      }
      throw error;
    }
  }

  // Return in chronological order (oldest first)
  return messages.reverse();
}

/**
 * Fetch thread replies for messages that have threads
 */
async function fetchThreadReplies(channelId: string, threadTs: string, slackBotToken: string): Promise<SlackMessage[]> {
  try {
    const url = new URL('https://slack.com/api/conversations.replies');
    url.searchParams.append('channel', channelId);
    url.searchParams.append('ts', threadTs);

    const response = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${slackBotToken}`,
        'Content-Type': 'application/json',
      },
    });

    const result = await response.json();

    if (result.ok && result.messages) {
      // Skip first message (parent) since we already have it
      return (result.messages as SlackMessage[]).slice(1);
    }

    return [];
  } catch (error: any) {
    // Check if this is a user validation error
    const slackErrorCode = error.additionalInfo?.slackErrorCode;
    const isUserError = slackErrorCode
      ? isSlackUserValidationError(slackErrorCode)
      : isSlackUserValidationErrorByMessage(error.message);

    if (isUserError) {
      Logger.warn('⚠️ Error fetching thread replies (user error)', {
        error: error.message || error,
        channelId,
        threadTs,
        slackErrorCode,
        errorType: 'user_validation',
      });
    } else {
      Logger.error('❌ Error fetching thread replies', {
        error,
        channelId,
        threadTs,
        errorType: 'system_error',
      });
    }
    return [];
  }
}

/**
 * Escape CSV field to prevent formula injection and parsing issues
 */
function escapeCsvField(field: string): string {
  if (!field) return '';

  // Prevent CSV formula injection (security vulnerability)
  if (field.startsWith('=') || field.startsWith('+') || field.startsWith('-') || field.startsWith('@')) {
    field = "'" + field; // Prefix with single quote to neutralize formula
  }

  // Escape quotes and newlines for proper CSV parsing
  field = field.replace(/"/g, '""').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

  return field;
}

/**
 * Sanitize filename to prevent path traversal and invalid characters
 */
function sanitizeFilename(name: string): string {
  if (!name) return '';
  // Remove or replace unsafe characters: / \ .. : * ? " < > |
  return name.replace(/[/\\:*?"<>|.]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Convert messages to CSV format
 */
function formatAsCSV(exportData: ExportResult): string {
  const rows: string[] = ['timestamp,user_id,user_name,text,thread_ts,reply_count,has_attachments'];

  for (const message of exportData.messages) {
    const text = escapeCsvField(message.text);
    const timestamp = new Date(parseFloat(message.ts) * 1000).toISOString();
    const userName = escapeCsvField(message.user_name || '');
    const replyCount = message.replies?.length || 0;
    const hasAttachments = message.attachments && message.attachments.length > 0 ? 'yes' : 'no';

    rows.push(
      `"${timestamp}","${message.user || ''}","${userName}","${text}","${message.thread_ts || ''}",${replyCount},${hasAttachments}`
    );
  }

  return rows.join('\n');
}

/**
 * Convert messages to Markdown format (optimized with string array builder)
 */
function formatAsMarkdown(exportData: ExportResult): string {
  const parts: string[] = [];

  // Header
  parts.push(`# Slack Export: #${exportData.channel.name || exportData.channel.id}\n`);
  parts.push(`**Exported**: ${exportData.exported_at}\n`);
  parts.push(`**Messages**: ${exportData.message_count}\n\n`);
  parts.push(`---\n\n`);

  // Messages
  for (const message of exportData.messages) {
    const timestamp = new Date(parseFloat(message.ts) * 1000).toLocaleString();
    const userName = message.user_name || message.user || 'Unknown';

    parts.push(`**${userName}** (${timestamp})\n`);
    parts.push(`${message.text}\n`);

    if (message.replies && message.replies.length > 0) {
      parts.push(`\n*Thread replies (${message.replies.length})*:\n`);
      for (const reply of message.replies) {
        const replyTime = new Date(parseFloat(reply.ts) * 1000).toLocaleString();
        const replyUser = reply.user_name || reply.user || 'Unknown';
        parts.push(`  - **${replyUser}** (${replyTime}): ${reply.text}\n`);
      }
    }

    parts.push(`\n`);
  }

  return parts.join('');
}

const handler = baseApi().post(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const result = ExportRequestSchema.safeParse(req.body);
  if (!result.success) {
    throw new BadRequestError(result.error.issues[0]?.message || 'Invalid request body');
  }

  const { workspaceId, channelId, dateRange, includeThreads, includeUserNames, format } = result.data;
  const startTime = Date.now();

  // Track export state for partial exports
  const warnings: ExportWarning[] = [];
  const stats: ExportStats = {
    messages_fetched: 0,
    threads_fetched: 0,
    thread_replies_fetched: 0,
    users_resolved: 0,
    users_failed: 0,
    duration_ms: 0,
  };

  let messages: SlackMessage[] = [];
  let channelName: string | undefined;
  let exportStatus: 'complete' | 'partial' | 'failed' = 'complete';
  let exportError: ExportResult['error'] | undefined;
  let currentPhase = 'initialization';

  Logger.info('📦 [Slack Export] Starting channel export', {
    workspaceId,
    channelId,
    format,
    includeThreads,
    includeUserNames,
    adminUserId: req.user?.id,
  });

  // Request-level timeout to prevent zombie processes
  let timedOut = false;
  const requestTimeoutId = setTimeout(() => {
    timedOut = true;
    Logger.error('❌ [Slack Export] Request timeout', {
      workspaceId,
      channelId,
      maxTime: MAX_EXPORT_TIME / 1000 / 60 + ' minutes',
      phase: currentPhase,
      messagesSoFar: messages.length,
    });
  }, MAX_EXPORT_TIME);

  // Helper to check timeout - returns true if timed out (for graceful handling)
  const isTimedOut = () => timedOut;

  // Helper to add warnings
  const addWarning = (phase: string, message: string, details?: string) => {
    warnings.push({
      phase,
      message,
      details,
      timestamp: new Date().toISOString(),
    });
    Logger.warn(`⚠️ [Slack Export] ${message}`, { phase, details });
  };

  // Helper to build and send export (supports partial exports)
  const buildAndSendExport = () => {
    stats.duration_ms = Date.now() - startTime;

    const exportData: ExportResult = {
      channel: {
        id: channelId,
        name: channelName,
      },
      exported_at: new Date().toISOString(),
      message_count: messages.length,
      messages,
      export_status: exportStatus,
      warnings: warnings.length > 0 ? warnings : undefined,
      stats,
      error: exportError,
    };

    // Sanitize channel name for safe filename
    const safeChannelName = sanitizeFilename(channelName || '') || channelId;
    const dateSuffix = new Date().toISOString().split('T')[0];
    const statusSuffix = exportStatus === 'partial' ? '-partial' : '';

    let content: string;
    let contentType: string;
    let filename: string;

    switch (format) {
      case 'csv':
        content = formatAsCSV(exportData);
        contentType = 'text/csv';
        filename = `slack-${safeChannelName}-${dateSuffix}${statusSuffix}.csv`;
        break;

      case 'markdown':
        content = formatAsMarkdown(exportData);
        contentType = 'text/markdown';
        filename = `slack-${safeChannelName}-${dateSuffix}${statusSuffix}.md`;
        break;

      case 'json':
      default:
        content = JSON.stringify(exportData, null, 2);
        contentType = 'application/json';
        filename = `slack-${safeChannelName}-${dateSuffix}${statusSuffix}.json`;
        break;
    }

    Logger.info(`✅ [Slack Export] Export ${exportStatus}`, {
      workspaceId,
      channelId,
      format,
      messageCount: messages.length,
      warningCount: warnings.length,
      filename,
      durationMs: stats.duration_ms,
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Add custom header to indicate partial export (useful for client-side handling)
    if (exportStatus === 'partial') {
      res.setHeader('X-Export-Status', 'partial');
      res.setHeader('X-Export-Warning-Count', warnings.length.toString());
    }
    return res.send(content);
  };

  try {
    // Phase 1: Get workspace
    currentPhase = 'workspace_authentication';
    const workspace = await slackDevWorkspaceRepository.findByIdWithToken(workspaceId);
    if (!workspace || !workspace.isActive) {
      throw new BadRequestError('Workspace not found or inactive. Please check the workspace is still connected.');
    }

    const slackBotToken = decryptToken(workspace.slackBotToken);
    if (!slackBotToken) {
      throw new BadRequestError(
        'Workspace authentication expired. Go to Admin → Slack Workspaces and reconnect your workspace.'
      );
    }

    // Phase 2: Fetch messages
    currentPhase = 'fetching_messages';
    try {
      messages = await fetchAllMessages(channelId, slackBotToken, dateRange);
      stats.messages_fetched = messages.length;
    } catch (error: any) {
      // If error has slackErrorCode in additionalInfo (from createSlackExportError),
      // enhance the message with suggestion and re-throw
      const slackErrorCode = error.additionalInfo?.slackErrorCode;
      if (slackErrorCode) {
        const errorInfo = getSlackErrorInfo(slackErrorCode);
        throw createSlackExportError(`${errorInfo.message} ${errorInfo.suggestion}`, slackErrorCode);
      }
      throw error;
    }

    if (isTimedOut()) {
      addWarning(
        'fetching_messages',
        'Export timed out while fetching messages',
        `Fetched ${messages.length} messages before timeout`
      );
      exportStatus = 'partial';
      exportError = {
        message: 'Export timed out during message fetching',
        phase: currentPhase,
        suggestion: 'Try using a narrower date range to export smaller batches.',
      };
      return buildAndSendExport();
    }

    Logger.info('✅ Fetched all messages', { count: messages.length });

    // Phase 3: Fetch thread replies
    if (includeThreads) {
      currentPhase = 'fetching_threads';
      const threadParents = messages.filter(m => m.thread_ts && m.thread_ts === m.ts);

      if (threadParents.length > 0) {
        Logger.info('📥 Fetching thread replies concurrently', { threadCount: threadParents.length });

        const limit = pLimit(20);
        let threadsFetched = 0;
        let threadsFailed = 0;

        const threadPromises = threadParents.map(parent =>
          limit(async () => {
            try {
              const replies = await fetchThreadReplies(channelId, parent.thread_ts!, slackBotToken);
              threadsFetched++;
              return { ts: parent.ts, replies, success: true };
            } catch (error: any) {
              threadsFailed++;
              Logger.warn('⚠️ Failed to fetch thread', { threadTs: parent.thread_ts, error: error.message });
              return { ts: parent.ts, replies: [], success: false };
            }
          })
        );

        const allThreads = await Promise.all(threadPromises);

        // Map replies back to messages
        let totalReplies = 0;
        for (const { ts, replies } of allThreads) {
          const message = messages.find(m => m.ts === ts);
          if (message) {
            message.replies = replies;
            totalReplies += replies.length;
          }
        }

        stats.threads_fetched = threadsFetched;
        stats.thread_replies_fetched = totalReplies;

        if (threadsFailed > 0) {
          addWarning(
            'fetching_threads',
            `Failed to fetch ${threadsFailed} of ${threadParents.length} threads`,
            'Some thread replies may be missing. This can happen due to rate limiting or permission issues.'
          );
          exportStatus = 'partial';
        }

        Logger.info('✅ Fetched thread replies', { threadsFetched, threadsFailed, totalReplies });
      }

      if (isTimedOut()) {
        addWarning('fetching_threads', 'Export timed out while fetching threads', 'Some threads may be incomplete');
        exportStatus = 'partial';
        exportError = {
          message: 'Export timed out during thread fetching',
          phase: currentPhase,
          suggestion: 'Messages were exported but some thread replies may be missing.',
        };
        return buildAndSendExport();
      }
    }

    // Phase 4: Resolve user names
    if (includeUserNames) {
      currentPhase = 'resolving_users';
      const userCache = new Map<string, string>();
      const failedUsers = new Set<string>();

      // Collect all unique user IDs
      const userIds = new Set<string>();
      for (const message of messages) {
        if (message.user) userIds.add(message.user);
        message.replies?.forEach(reply => {
          if (reply.user) userIds.add(reply.user);
        });
      }

      // Resolve users with error tracking
      const limit = pLimit(10);
      const userPromises = Array.from(userIds).map(userId =>
        limit(async () => {
          if (userCache.has(userId)) return;

          try {
            const url = new URL('https://slack.com/api/users.info');
            url.searchParams.append('user', userId);

            const response = await fetchWithRetry(url.toString(), {
              method: 'GET',
              headers: {
                Authorization: `Bearer ${slackBotToken}`,
                'Content-Type': 'application/json',
              },
            });

            const result = await response.json();
            if (result.ok && result.user) {
              const name = result.user.real_name || result.user.name || userId;
              userCache.set(userId, name);
            } else {
              failedUsers.add(userId);
              userCache.set(userId, userId);
            }
          } catch (error) {
            failedUsers.add(userId);
            userCache.set(userId, userId);
          }
        })
      );

      await Promise.all(userPromises);

      stats.users_resolved = userCache.size - failedUsers.size;
      stats.users_failed = failedUsers.size;

      if (failedUsers.size > 0) {
        addWarning(
          'resolving_users',
          `Could not resolve ${failedUsers.size} of ${userIds.size} user names`,
          'Some messages will show user IDs instead of names. This can happen for deactivated users or bots.'
        );
        // Don't mark as partial just for user name resolution - it's non-critical
      }

      // Map resolved names back to messages
      for (const message of messages) {
        if (message.user) {
          message.user_name = userCache.get(message.user) || message.user;
        }
        if (message.replies) {
          for (const reply of message.replies) {
            if (reply.user) {
              reply.user_name = userCache.get(reply.user) || reply.user;
            }
          }
        }
      }

      Logger.info('✅ Resolved user names', { resolved: stats.users_resolved, failed: stats.users_failed });

      if (isTimedOut()) {
        addWarning('resolving_users', 'Export timed out while resolving user names', 'Some users may show as IDs');
        exportStatus = 'partial';
        return buildAndSendExport();
      }
    }

    // Phase 5: Get channel name (non-critical, don't fail on error)
    currentPhase = 'fetching_channel_info';
    try {
      const url = new URL('https://slack.com/api/conversations.info');
      url.searchParams.append('channel', channelId);

      const response = await fetchWithRetry(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${slackBotToken}`,
          'Content-Type': 'application/json',
        },
      });

      const channelInfo = await response.json();
      if (channelInfo.ok && channelInfo.channel) {
        channelName = channelInfo.channel.name;
      }
    } catch (error) {
      addWarning('fetching_channel_info', 'Could not fetch channel name', 'Export will use channel ID in filename');
    }

    // Success - send complete export
    return buildAndSendExport();
  } catch (error: any) {
    clearTimeout(requestTimeoutId);

    // If we have some messages, return a partial export with the error
    if (messages.length > 0) {
      exportStatus = 'partial';
      exportError = {
        message: error.message || 'Unknown error occurred',
        phase: currentPhase,
        suggestion: getSuggestionForPhase(currentPhase, error),
      };
      addWarning(
        currentPhase,
        `Export failed: ${error.message}`,
        'Returning partial export with data collected so far'
      );

      Logger.warn('⚠️ [Slack Export] Returning partial export due to error', {
        error: error.message,
        phase: currentPhase,
        messagesCollected: messages.length,
      });

      return buildAndSendExport();
    }

    // No data collected - throw the error
    // Check if this is a user validation error
    const slackErrorCode = error.additionalInfo?.slackErrorCode;
    const isUserError = slackErrorCode
      ? isSlackUserValidationError(slackErrorCode)
      : isSlackUserValidationErrorByMessage(error.message);

    if (isUserError) {
      Logger.warn('⚠️ [Slack Export] Export failed with no data (user error)', {
        error: error.message,
        phase: currentPhase,
        workspaceId,
        channelId,
        slackErrorCode,
        errorType: 'user_validation',
      });
    } else {
      Logger.error('❌ [Slack Export] Export failed with no data', {
        error: error.message,
        phase: currentPhase,
        workspaceId,
        channelId,
        errorType: 'system_error',
      });
    }

    // Enhance error message with suggestion
    const suggestion = getSuggestionForPhase(currentPhase, error);
    throw new BadRequestError(`${error.message}. ${suggestion}`);
  } finally {
    clearTimeout(requestTimeoutId);
  }
});

/**
 * Get helpful suggestion based on the phase where error occurred
 */
function getSuggestionForPhase(phase: string, error: any): string {
  const suggestions: Record<string, string> = {
    workspace_authentication: 'Check that the Slack workspace is still connected and active.',
    fetching_messages: 'Try using a narrower date range or check that the bot has access to this channel.',
    fetching_threads: 'Messages were exported but thread fetching failed. Try exporting without threads.',
    resolving_users: 'Messages were exported but user name resolution failed. Try exporting without user names.',
    fetching_channel_info: 'Export succeeded but channel name could not be retrieved.',
  };

  // Check for specific error patterns
  if (error.message?.includes('timeout')) {
    return 'The export timed out. Try using a narrower date range to export smaller batches.';
  }
  if (error.message?.includes('rate limit')) {
    return 'Slack rate limit exceeded. Wait a few minutes and try again with a smaller date range.';
  }

  return suggestions[phase] || 'Please try again or contact support if the issue persists.';
}

export default handler;
