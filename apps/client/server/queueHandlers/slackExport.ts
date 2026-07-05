import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { z } from 'zod';
import { slackDevWorkspaceRepository, slackExportJobRepository } from '@bike4mind/database';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { Resource } from 'sst';
import pLimit from 'p-limit';
import {
  isSlackUserValidationError,
  isSlackUserValidationErrorByMessage,
} from '@server/integrations/slack/slackExportErrors';
import { decryptToken } from '@server/security/tokenEncryption';

const PayloadSchema = z.object({
  jobId: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
  channelId: z.string(),
  format: z.enum(['json', 'csv', 'markdown']),
  includeThreads: z.boolean(),
  includeUserNames: z.boolean(),
  dateRange: z
    .object({
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .optional(),
});

// Safety limits
const FETCH_TIMEOUT = 30000; // 30 seconds per API call
const PRESIGNED_URL_EXPIRY = 3600; // 1 hour
const PROGRESS_UPDATE_INTERVAL = 1000; // Update progress every 1 second max

interface SlackMessage {
  ts: string;
  user?: string;
  user_name?: string;
  text: string;
  thread_ts?: string;
  replies?: SlackMessage[];
  attachments?: unknown[];
}

interface ExportResult {
  channel: {
    id: string;
    name?: string;
  };
  exported_at: string;
  message_count: number;
  messages: SlackMessage[];
  export_status: 'complete' | 'partial';
  stats: {
    messages_fetched: number;
    threads_fetched: number;
    thread_replies_fetched: number;
    users_resolved: number;
    duration_ms: number;
  };
}

/**
 * Fetch with timeout and retry logic for Slack rate limits
 */
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
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

      const backoff = Math.min(1000 * Math.pow(2, attempt), 10000);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }

  throw new Error('Max retries exceeded');
}

/**
 * Translate Slack API error codes to user-friendly messages
 */
function getSlackErrorMessage(errorCode: string): string {
  const errorMessages: Record<string, string> = {
    channel_not_found: 'Channel not found or bot is not a member.',
    not_in_channel: 'Bot is not a member of this channel.',
    invalid_auth: 'Workspace authentication has expired.',
    account_inactive: 'Slack workspace is inactive or suspended.',
    token_revoked: 'Bot token has been revoked.',
    missing_scope: 'Bot is missing required permissions.',
    is_archived: 'This channel has been archived.',
    ratelimited: 'Slack rate limit exceeded.',
  };

  return errorMessages[errorCode] || `Slack API error: ${errorCode}`;
}

/**
 * Escape CSV field to prevent formula injection
 */
function escapeCsvField(field: string): string {
  if (!field) return '';

  if (field.startsWith('=') || field.startsWith('+') || field.startsWith('-') || field.startsWith('@')) {
    field = "'" + field;
  }

  field = field.replace(/"/g, '""').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

  return field;
}

/**
 * Sanitize filename
 */
function sanitizeFilename(name: string): string {
  if (!name) return '';
  return name.replace(/[/\\:*?"<>|.]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Format as CSV
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
 * Format as Markdown
 */
function formatAsMarkdown(exportData: ExportResult): string {
  const parts: string[] = [];

  parts.push(`# Slack Export: #${exportData.channel.name || exportData.channel.id}\n`);
  parts.push(`**Exported**: ${exportData.exported_at}\n`);
  parts.push(`**Messages**: ${exportData.message_count}\n\n`);
  parts.push(`---\n\n`);

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

export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const body = event.Records[0].body;
  const payload = PayloadSchema.parse(JSON.parse(body));

  const { jobId, userId, workspaceId, channelId, format, includeThreads, includeUserNames, dateRange } = payload;

  logger.updateMetadata({
    jobId,
    userId,
    workspaceId,
    channelId,
  });

  logger.info('🚀 Starting Slack export job');

  const startTime = Date.now();
  let lastProgressUpdate = 0;

  // Helper to update progress (throttled to avoid DB spam)
  const updateProgress = async (
    progress: number,
    step: string,
    stats?: {
      processedMessages?: number;
      totalMessages?: number;
      threadsFetched?: number;
      threadRepliesFetched?: number;
      usersResolved?: number;
    }
  ) => {
    const now = Date.now();
    if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL && progress < 100) {
      return;
    }
    lastProgressUpdate = now;

    await slackExportJobRepository.updateProgress(jobId, {
      progress,
      currentStep: step,
      ...stats,
    });
  };

  try {
    // Check if job was cancelled
    const job = await slackExportJobRepository.findById(jobId);
    if (!job || job.status === 'cancelled') {
      logger.info('⏹️ Job was cancelled, exiting');
      return;
    }

    // Mark job as started
    await slackExportJobRepository.markStarted(jobId);
    await updateProgress(5, 'Authenticating with Slack...');

    // Get workspace with token
    const workspace = await slackDevWorkspaceRepository.findByIdWithToken(workspaceId);
    if (!workspace || !workspace.isActive || !workspace.slackBotToken) {
      throw new Error('Workspace not found or authentication expired');
    }

    const slackBotToken = decryptToken(workspace.slackBotToken) ?? '';

    // Fetch channel info
    await updateProgress(10, 'Fetching channel information...');
    let channelName: string | undefined;

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
      logger.warn('Could not fetch channel name', { error });
    }

    // Fetch all messages with pagination
    await updateProgress(15, 'Fetching messages from Slack...');

    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    let hasMore = true;

    const oldest = dateRange?.start ? new Date(dateRange.start).getTime() / 1000 : undefined;
    const latest = dateRange?.end ? new Date(dateRange.end).getTime() / 1000 : undefined;

    while (hasMore) {
      // Check for cancellation periodically
      const currentJob = await slackExportJobRepository.findById(jobId);
      if (currentJob?.status === 'cancelled') {
        logger.info('⏹️ Job cancelled during message fetch');
        return;
      }

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

        // Update progress (15-50% for message fetching)
        const progress = hasMore ? Math.min(15 + Math.floor(messages.length / 100), 50) : 50;
        await updateProgress(progress, `Fetched ${messages.length.toLocaleString()} messages...`, {
          processedMessages: messages.length,
        });

        logger.info('📥 Fetched messages batch', {
          batchSize: result.messages.length,
          totalSoFar: messages.length,
          hasMore,
        });
      } else {
        throw new Error(getSlackErrorMessage(result.error));
      }
    }

    // Reverse to chronological order
    messages.reverse();

    await updateProgress(50, `Processing ${messages.length.toLocaleString()} messages...`, {
      totalMessages: messages.length,
      processedMessages: messages.length,
    });

    // Fetch thread replies
    let threadsFetched = 0;
    let threadRepliesFetched = 0;

    if (includeThreads) {
      const threadParents = messages.filter(m => m.thread_ts && m.thread_ts === m.ts);

      if (threadParents.length > 0) {
        await updateProgress(55, `Fetching ${threadParents.length} threads...`);

        const limit = pLimit(10); // Lower concurrency to avoid rate limits

        const threadPromises = threadParents.map((parent, index) =>
          limit(async () => {
            try {
              const url = new URL('https://slack.com/api/conversations.replies');
              url.searchParams.append('channel', channelId);
              url.searchParams.append('ts', parent.thread_ts!);

              const response = await fetchWithRetry(url.toString(), {
                method: 'GET',
                headers: {
                  Authorization: `Bearer ${slackBotToken}`,
                  'Content-Type': 'application/json',
                },
              });

              const result = await response.json();

              if (result.ok && result.messages) {
                const replies = (result.messages as SlackMessage[]).slice(1);
                threadsFetched++;
                threadRepliesFetched += replies.length;

                // Update progress periodically
                if (index % 10 === 0) {
                  const progress = 55 + Math.floor((index / threadParents.length) * 20);
                  await updateProgress(progress, `Fetched ${threadsFetched}/${threadParents.length} threads...`, {
                    threadsFetched,
                    threadRepliesFetched,
                  });
                }

                return { ts: parent.ts, replies };
              }

              return { ts: parent.ts, replies: [] };
            } catch (error) {
              logger.warn('Failed to fetch thread', { threadTs: parent.thread_ts, error });
              return { ts: parent.ts, replies: [] };
            }
          })
        );

        const allThreads = await Promise.all(threadPromises);

        // Map replies back to messages
        for (const { ts, replies } of allThreads) {
          const message = messages.find(m => m.ts === ts);
          if (message) {
            message.replies = replies;
          }
        }

        logger.info('✅ Fetched thread replies', { threadsFetched, threadRepliesFetched });
      }
    }

    await updateProgress(75, 'Resolving user names...', { threadsFetched, threadRepliesFetched });

    // Resolve user names
    let usersResolved = 0;

    if (includeUserNames) {
      const userCache = new Map<string, string>();

      // Collect unique user IDs
      const userIds = new Set<string>();
      for (const message of messages) {
        if (message.user) userIds.add(message.user);
        message.replies?.forEach(reply => {
          if (reply.user) userIds.add(reply.user);
        });
      }

      if (userIds.size > 0) {
        const limit = pLimit(5); // Very conservative for user lookups

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
                usersResolved++;
              } else {
                userCache.set(userId, userId);
              }
            } catch (error) {
              userCache.set(userId, userId);
            }
          })
        );

        await Promise.all(userPromises);

        // Map names back to messages
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

        logger.info('✅ Resolved user names', { usersResolved, totalUsers: userIds.size });
      }
    }

    await updateProgress(85, 'Formatting export...', { usersResolved });

    // Build export data
    const exportData: ExportResult = {
      channel: {
        id: channelId,
        name: channelName,
      },
      exported_at: new Date().toISOString(),
      message_count: messages.length,
      messages,
      export_status: 'complete',
      stats: {
        messages_fetched: messages.length,
        threads_fetched: threadsFetched,
        thread_replies_fetched: threadRepliesFetched,
        users_resolved: usersResolved,
        duration_ms: Date.now() - startTime,
      },
    };

    // Format content
    let content: string;
    let contentType: string;
    let fileExtension: string;

    switch (format) {
      case 'csv':
        content = formatAsCSV(exportData);
        contentType = 'text/csv';
        fileExtension = 'csv';
        break;

      case 'markdown':
        content = formatAsMarkdown(exportData);
        contentType = 'text/markdown';
        fileExtension = 'md';
        break;

      case 'json':
      default:
        content = JSON.stringify(exportData, null, 2);
        contentType = 'application/json';
        fileExtension = 'json';
        break;
    }

    await updateProgress(90, 'Uploading to storage...');

    // Upload to S3
    const safeChannelName = sanitizeFilename(channelName || '') || channelId;
    const dateSuffix = new Date().toISOString().split('T')[0];
    const filename = `slack-${safeChannelName}-${dateSuffix}.${fileExtension}`;
    const s3Key = `exports/${userId}/${jobId}/${filename}`;

    const s3Client = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
    const s3Bucket = Resource.slackExportBucket.name;

    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
        Body: content,
        ContentType: contentType,
        ContentDisposition: `attachment; filename="${filename}"`,
      })
    );

    const fileSize = Buffer.byteLength(content, 'utf8');

    logger.info('✅ Uploaded export to S3', {
      s3Bucket,
      s3Key,
      fileSize,
    });

    // Generate presigned download URL
    const downloadUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: s3Bucket,
        Key: s3Key,
      }),
      { expiresIn: PRESIGNED_URL_EXPIRY }
    );

    const downloadExpiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY * 1000);

    // Mark job as complete
    await slackExportJobRepository.markComplete(jobId, {
      s3Bucket,
      s3Key,
      fileSize,
      downloadUrl,
      downloadExpiresAt,
      channelName,
      processedMessages: messages.length,
      threadsFetched,
      threadRepliesFetched,
      usersResolved,
    });

    const duration = Date.now() - startTime;
    logger.info('✅ Slack export completed successfully', {
      jobId,
      channelId,
      channelName,
      messageCount: messages.length,
      threadsFetched,
      threadRepliesFetched,
      usersResolved,
      fileSize,
      durationMs: duration,
    });
  } catch (error: any) {
    // Use WARN for expected user errors, ERROR for unexpected failures
    // Prefer error code from additionalInfo (set by createSlackExportError),
    // fall back to message-based detection for wrapped/re-thrown errors
    const slackErrorCode = error.additionalInfo?.slackErrorCode;
    const isUserError = slackErrorCode
      ? isSlackUserValidationError(slackErrorCode)
      : isSlackUserValidationErrorByMessage(error.message);

    if (isUserError) {
      logger.warn('⚠️ Slack export failed (user error)', {
        jobId,
        error: error.message,
        slackErrorCode,
        errorType: 'user_validation',
      });
    } else {
      logger.error('❌ Slack export failed', {
        jobId,
        error: error.message,
        slackErrorCode,
        stack: error.stack,
        errorType: 'system_error',
      });
    }

    await slackExportJobRepository.markFailed(jobId, {
      message: error.message || 'Unknown error occurred',
      stack: error.stack,
    });

    throw error; // Re-throw to trigger DLQ on retry exhaustion
  }
});
