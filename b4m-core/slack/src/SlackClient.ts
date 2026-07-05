import { isPlaceholderValue } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { WebClient, WebClientEvent, KnownBlock, Block, ChatPostEphemeralArguments } from '@slack/web-api';
import { getSlackDeps, getSlackDb } from './di/registry';

/**
 * Slack message metadata for app-to-app communication
 * Used to store confirmation tokens without displaying them to users
 */
export interface SlackMetadata {
  event_type: string;
  event_payload: Record<string, unknown>;
}

/**
 * Parameters for sending a Slack message
 */
export interface SendMessageParams {
  channel: string;
  text: string;
  threadTs?: string; // Thread timestamp if replying in a thread
  blocks?: (KnownBlock | Block)[]; // Slack Block Kit blocks for rich formatting
  metadata?: SlackMetadata; // Hidden metadata for app-to-app communication
}

/**
 * Parameters for updating a Slack message
 */
export interface UpdateMessageParams {
  channel: string;
  ts: string; // Message timestamp to update
  text: string;
  blocks?: (KnownBlock | Block)[]; // Slack Block Kit blocks for rich formatting
}

/**
 * Parameters for uploading a file to Slack
 */
export interface UploadFileParams {
  channel: string;
  filename: string;
  content: Buffer;
  threadTs?: string;
  initialComment?: string;
}

/**
 * Result of a file upload operation
 */
export interface FileUploadResult {
  fileId: string;
  url?: string;
  success: boolean;
}

/**
 * Slack message representation
 */
export interface SlackMessage {
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
  type?: string;
  metadata?: SlackMetadata; // Hidden metadata for app-to-app communication
}

/**
 * Slack user information
 */
export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  email?: string;
  /** User's timezone as IANA string (e.g., "America/Los_Angeles") */
  tz?: string;
  /** Whether the user is a Slack workspace admin */
  is_admin?: boolean;
  /** Whether the user is a Slack workspace owner */
  is_owner?: boolean;
}

/**
 * Parameters for scheduling a Slack message
 */
export interface ScheduleMessageParams {
  channel: string;
  text: string;
  /** Unix timestamp in seconds when the message should be posted */
  postAt: number;
  threadTs?: string;
}

/**
 * Result of scheduling a message
 */
export interface ScheduleMessageResult {
  scheduledMessageId: string;
  postAt: number;
  channel: string;
}

/**
 * A scheduled message from Slack
 */
export interface ScheduledMessage {
  id: string;
  channel: string;
  text: string;
  postAt: number;
  dateCreated: number;
}

/**
 * Result of creating a reminder
 */
export interface ReminderResult {
  id: string;
  text: string;
  time: number;
  user: string;
}

export interface SlackSearchResult {
  total: number;
  pagination: {
    total_count: number;
    page: number;
    per_page: number;
    page_count: number;
    first: number;
    last: number;
  };
  paging: {
    count: number;
    total: number;
    page: number;
    pages: number;
  };
  matches: Array<{
    iid: string;
    team: string;
    score: number;
    channel: {
      id: string;
      is_channel: boolean;
      is_group: boolean;
      is_im: boolean;
      name: string;
      is_shared: boolean;
      is_org_shared: boolean;
      is_ext_shared: boolean;
      is_private: boolean;
      is_mpim: boolean;
      pending_shared: Array<string>;
      is_pending_ext_shared: boolean;
    };
    type: string;
    user: string;
    username: string;
    ts: string;
    text: string;
    permalink: string;
    no_reactions: boolean;
    blocks?: Array<any>;
    attachments?: Array<any>;
  }>;
}

/**
 * Centralized interface for all Slack API interactions via the @slack/web-api SDK.
 * The SDK handles retry with exponential backoff and rate-limit Retry-After headers.
 */
export class SlackClient {
  private client: WebClient;
  private logger: Logger;
  private readonly MAX_TEXT_LENGTH = 4000; // Slack's character limit

  constructor(botToken: string, logger: Logger) {
    if (isPlaceholderValue(botToken)) {
      throw new Error('Slack bot token is not configured - cannot initialize SlackClient');
    }
    this.client = new WebClient(botToken, {
      retryConfig: {
        retries: 2, // Low retries for Lambda timeout budget
      },
    });
    this.logger = logger;

    // Track Slack rate limit events (429s) for the rate limit dashboard
    this.client.on(WebClientEvent.RATE_LIMITED, (retrySec: number, { url }: { url: string }) => {
      const endpoint = url || 'unknown';
      this.logger.warn(`[Slack] Rate limited on ${endpoint}, retry after ${retrySec}s`);

      const { rateLimitSnapshotRepository } = getSlackDb() as any;
      const { cloudwatch } = getSlackDeps();

      // Fire-and-forget: persist to MongoDB
      rateLimitSnapshotRepository
        .create({
          integration: 'slack' as const,
          userId: 'system',
          endpoint,
          limit: null, // Slack doesn't expose limit headers on successful responses
          remaining: 0,
          resetAt: new Date(Date.now() + retrySec * 1000),
          usagePercent: 100,
          wasThrottled: true,
          retryAfterMs: retrySec * 1000,
          timestamp: new Date(),
        })
        .catch((err: unknown) => this.logger.error('[Slack] Failed to persist rate limit snapshot', err));

      // Fire-and-forget: emit CloudWatch metric
      cloudwatch
        .recordRateLimitEvent('slack', 100, true, endpoint)
        .catch(err => this.logger.error('[Slack] Failed to emit CloudWatch rate limit metric', err));
    });
  }

  /**
   * Circuit breaker guard - returns false if Slack is known to be unhealthy.
   * Cached in memory so this is effectively free after the first call.
   */
  private async isSlackAvailable(): Promise<boolean> {
    try {
      const { integrationCircuitBreaker } = getSlackDeps();
      return await integrationCircuitBreaker.isAvailable('slack');
    } catch {
      // If the circuit breaker itself fails (e.g. DB unavailable), don't block Slack calls
      return true;
    }
  }

  // ============================================
  // Message Operations
  // ============================================

  /**
   * Helper to truncate text while preserving surrogate pairs (emojis)
   */
  private safeTruncate(text: string, maxLength: number): string {
    if (!text) return text;

    // Use spread operator to handle unicode surrogate pairs correctly
    const chars = [...text];

    if (chars.length <= maxLength) return text;

    const suffix = '... (truncated)';
    // Ensure we have enough space for the suffix
    const targetLength = Math.max(0, maxLength - suffix.length);

    return chars.slice(0, targetLength).join('') + suffix;
  }

  /**
   * Helper to truncate block text to avoid Slack API limits
   * Enforces specific limits per block type
   */
  private truncateBlocks(blocks: (KnownBlock | Block)[]): (KnownBlock | Block)[] {
    // Slack Limits (with safety margins)
    const LIMITS = {
      SECTION_TEXT: 2900, // Limit: 3000
      SECTION_FIELD: 1900, // Limit: 2000
      HEADER: 140, // Limit: 150
      CONTEXT: 1900, // Limit: 2000
      MARKDOWN: 11900, // Limit: 12000
    };

    return blocks.map(block => {
      // any: Slack Block Kit types are a union of many block shapes with deeply nested optional
      // fields. Proper narrowing for every variant adds significant complexity for a simple
      // truncation pass - using Record<string, any> lets us inspect/mutate fields generically.
      const newBlock = { ...block } as unknown as Record<string, any>;

      // 1. Header Blocks
      if (newBlock.type === 'header') {
        if (newBlock.text && typeof newBlock.text === 'object' && newBlock.text.text) {
          newBlock.text = {
            ...newBlock.text,
            text: this.safeTruncate(newBlock.text.text, LIMITS.HEADER),
          };
        }
        return newBlock as KnownBlock | Block;
      }

      // 2. Section Blocks
      if (newBlock.type === 'section') {
        // Main text
        if (newBlock.text && typeof newBlock.text === 'object' && newBlock.text.text) {
          newBlock.text = {
            ...newBlock.text,
            text: this.safeTruncate(newBlock.text.text, LIMITS.SECTION_TEXT),
          };
        }

        // Fields
        if (newBlock.fields && Array.isArray(newBlock.fields)) {
          newBlock.fields = newBlock.fields.map((field: any) => {
            if (field.text) {
              return {
                ...field,
                text: this.safeTruncate(field.text, LIMITS.SECTION_FIELD),
              };
            }
            return field;
          });
        }
        return newBlock as KnownBlock | Block;
      }

      // 3. Markdown Blocks
      if (newBlock.type === 'markdown') {
        if (typeof newBlock.text === 'string') {
          newBlock.text = this.safeTruncate(newBlock.text, LIMITS.MARKDOWN);
        }
        return newBlock as KnownBlock | Block;
      }

      // 4. Context Blocks
      if (newBlock.type === 'context' && newBlock.elements && Array.isArray(newBlock.elements)) {
        newBlock.elements = newBlock.elements.map((element: any) => {
          // Context elements: image or mrkdwn/plain_text
          if (element.text) {
            if (typeof element.text === 'string') {
              return { ...element, text: this.safeTruncate(element.text, LIMITS.CONTEXT) };
            }
            if (typeof element.text === 'object' && element.text.text) {
              return {
                ...element,
                text: {
                  ...element.text,
                  text: this.safeTruncate(element.text.text, LIMITS.CONTEXT),
                },
              };
            }
          }
          return element;
        });
        return newBlock as KnownBlock | Block;
      }

      return newBlock as KnownBlock | Block;
    });
  }

  /**
   * Send a message to a Slack channel or thread
   * Returns the message timestamp (ts) for future updates
   */
  async sendMessage(params: SendMessageParams): Promise<string | null> {
    // Circuit breaker: fail fast when Slack is known to be unhealthy
    if (!(await this.isSlackAvailable())) {
      this.logger.warn('Slack circuit breaker open — skipping sendMessage');
      return null;
    }

    const { channel, text, threadTs, blocks, metadata } = params;

    // Validate inputs
    if (!channel || !text) {
      this.logger.error('Invalid channel or text for Slack message', {
        channel,
        textLength: text?.length,
      });
      return null;
    }

    // Truncate text if too long
    const truncatedText = this.safeTruncate(text, this.MAX_TEXT_LENGTH);

    try {
      this.logger.info('Sending Slack message', {
        channel,
        textLength: truncatedText.length,
        threadTs: threadTs || 'none (channel message)',
        hasMetadata: !!metadata,
      });

      const result = await this.client.chat.postMessage({
        channel,
        text: truncatedText,
        thread_ts: threadTs,
        blocks: blocks && blocks.length > 0 ? this.truncateBlocks(blocks) : undefined,
        metadata: metadata as any, // Slack SDK types may be outdated
      });

      if (result.ok && result.ts) {
        this.logger.info('Successfully sent message to Slack', {
          channel,
          messageId: result.ts,
        });
        return result.ts;
      }

      return null;
    } catch (error) {
      this.logger.error('Error sending Slack message:', error);
      return null;
    }
  }

  /**
   * Send an ephemeral message (only visible to one user)
   * Used for confirmations and status messages that don't need to be public
   * Note: Ephemeral messages don't support threadTs or metadata
   *
   * @param params - Message parameters (channel, text, blocks)
   * @param userId - The user who will see the message
   * @returns true if successful, false otherwise
   */
  async sendEphemeralMessage(
    params: Omit<SendMessageParams, 'threadTs' | 'metadata'>,
    userId: string
  ): Promise<boolean> {
    const { channel, text, blocks } = params;

    // Validate inputs
    if (!channel || !text || !userId) {
      this.logger.error('Invalid parameters for ephemeral Slack message', {
        channel,
        textLength: text?.length,
        userId,
      });
      return false;
    }

    // Truncate text if too long
    const truncatedText = this.safeTruncate(text, this.MAX_TEXT_LENGTH);

    try {
      this.logger.info('Sending ephemeral Slack message', {
        channel,
        userId,
        textLength: truncatedText.length,
      });

      // Build the options object - ChatPostEphemeralArguments is a union type
      // so we construct the full object and cast to the appropriate union branch
      const options: ChatPostEphemeralArguments =
        blocks && blocks.length > 0
          ? {
              channel,
              user: userId,
              text: truncatedText,
              blocks: this.truncateBlocks(blocks),
            }
          : {
              channel,
              user: userId,
              text: truncatedText,
            };

      const result = await this.client.chat.postEphemeral(options);

      if (result.ok) {
        this.logger.info('Successfully sent ephemeral message to Slack', {
          channel,
          userId,
        });
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Error sending ephemeral Slack message:', error);
      return false;
    }
  }

  /**
   * Update an existing Slack message
   * @returns true if update succeeded, false if it failed
   * @throws Error if the update fails and throwOnError is true (default: false for backward compatibility)
   */
  async updateMessage(params: UpdateMessageParams, throwOnError: boolean = false): Promise<boolean> {
    // Circuit breaker: fail fast when Slack is known to be unhealthy
    if (!(await this.isSlackAvailable())) {
      this.logger.warn('Slack circuit breaker open — skipping updateMessage');
      if (throwOnError) {
        throw new Error('Slack integration is currently unavailable (health check: unhealthy). Retry later.');
      }
      return false;
    }

    const { channel, ts, text, blocks } = params;

    // Validate inputs
    if (!channel || !ts || !text) {
      this.logger.error('Invalid parameters for updating Slack message', {
        channel,
        ts,
        textLength: text?.length,
      });
      if (throwOnError) {
        throw new Error('Invalid parameters for updating Slack message');
      }
      return false;
    }

    // Truncate text if too long
    const truncatedText = this.safeTruncate(text, this.MAX_TEXT_LENGTH);

    try {
      const result = await this.client.chat.update({
        channel,
        ts,
        text: truncatedText,
        blocks: blocks && blocks.length > 0 ? this.truncateBlocks(blocks) : undefined,
      });

      if (result.ok) {
        return true;
      }

      // API returned ok: false - log the error
      this.logger.error('Slack API returned error for message update', {
        channel,
        ts,
        error: result.error,
      });

      if (throwOnError) {
        throw new Error(`Slack API error: ${result.error || 'unknown error'}`);
      }
      return false;
    } catch (error) {
      this.logger.error('Error updating Slack message:', error);
      if (throwOnError) {
        throw error;
      }
      return false;
    }
  }

  /**
   * Delete a Slack message
   */
  async deleteMessage(channel: string, ts: string): Promise<void> {
    this.logger.info('Deleting Slack message', { channel, ts });

    try {
      const result = await this.client.chat.delete({
        channel,
        ts,
      });

      if (result.ok) {
        this.logger.info('Successfully deleted Slack message', { channel, ts });
      }
    } catch (error) {
      this.logger.error('Error deleting Slack message:', error);
    }
  }

  // ============================================
  // Scheduled Message Operations
  // ============================================

  /**
   * Schedule a message for future delivery
   * Uses Slack's chat.scheduleMessage API - Slack handles storage and delivery
   *
   * @param params - Message parameters including channel, text, and postAt timestamp
   * @returns Scheduled message result with ID, or null on failure
   */
  async scheduleMessage(params: ScheduleMessageParams): Promise<ScheduleMessageResult | null> {
    const { channel, text, postAt, threadTs } = params;

    try {
      const result = await this.client.chat.scheduleMessage({
        channel,
        text,
        post_at: postAt,
        thread_ts: threadTs,
      });

      if (!result.ok || !result.scheduled_message_id) {
        this.logger.error('Failed to schedule Slack message', { channel, postAt });
        return null;
      }

      this.logger.info('Successfully scheduled Slack message', {
        channel,
        scheduledMessageId: result.scheduled_message_id,
        postAt,
      });

      return {
        scheduledMessageId: result.scheduled_message_id,
        postAt: result.post_at as number,
        channel,
      };
    } catch (error) {
      this.logger.error('Error scheduling Slack message:', error);
      return null;
    }
  }

  /**
   * List scheduled messages for a channel or all channels
   * Uses Slack's chat.scheduledMessages.list API
   *
   * @param channel - Optional channel ID to filter by
   * @returns Array of scheduled messages
   */
  async listScheduledMessages(channel?: string): Promise<ScheduledMessage[]> {
    try {
      const result = await this.client.chat.scheduledMessages.list({
        channel,
      });

      if (!result.ok || !result.scheduled_messages) {
        this.logger.error('Failed to list scheduled Slack messages');
        return [];
      }

      return result.scheduled_messages.map(msg => ({
        id: msg.id ?? '',
        channel: msg.channel_id ?? '',
        text: msg.text ?? '',
        postAt: msg.post_at ?? 0,
        dateCreated: msg.date_created ?? 0,
      }));
    } catch (error) {
      this.logger.error('Error listing scheduled Slack messages:', error);
      return [];
    }
  }

  /**
   * Delete/cancel a scheduled message
   * Uses Slack's chat.deleteScheduledMessage API
   *
   * @param channel - Channel where the message was scheduled
   * @param scheduledMessageId - ID of the scheduled message to cancel
   * @returns true if successful, false otherwise
   */
  async deleteScheduledMessage(channel: string, scheduledMessageId: string): Promise<boolean> {
    try {
      const result = await this.client.chat.deleteScheduledMessage({
        channel,
        scheduled_message_id: scheduledMessageId,
      });

      if (result.ok) {
        this.logger.info('Successfully cancelled scheduled Slack message', {
          channel,
          scheduledMessageId,
        });
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error('Error cancelling scheduled Slack message:', error);
      return false;
    }
  }

  // ============================================
  // Direct Message Operations
  // ============================================

  /**
   * Send a direct message to a user
   * Opens a DM conversation if needed and sends the message
   *
   * @param userId - Slack user ID to send DM to
   * @param text - Message text
   * @returns Message timestamp (ts) if successful, null otherwise
   */
  async sendDirectMessage(userId: string, text: string): Promise<string | null> {
    try {
      // Open a DM conversation with the user
      const openResult = await this.client.conversations.open({
        users: userId,
      });

      if (!openResult.ok || !openResult.channel?.id) {
        this.logger.error('Failed to open DM conversation', {
          userId,
          error: openResult.error,
        });
        return null;
      }

      const dmChannelId = openResult.channel.id;

      // Send the message to the DM channel
      return await this.sendMessage({
        channel: dmChannelId,
        text,
      });
    } catch (error) {
      this.logger.error('Error sending direct message:', error);
      return null;
    }
  }

  /**
   * Open a DM conversation with a user and return the channel ID.
   * Returns null if the conversation cannot be opened.
   */
  async openDmChannel(userId: string): Promise<string | null> {
    try {
      const result = await this.client.conversations.open({ users: userId });
      if (!result.ok || !result.channel?.id) {
        this.logger.error('Failed to open DM channel', { userId, error: result.error });
        return null;
      }
      return result.channel.id;
    } catch (error) {
      this.logger.error('Error opening DM channel:', error);
      return null;
    }
  }

  // ============================================
  // Reminder Operations
  // ============================================

  /**
   * Create a reminder for a user
   * Uses Slack's reminders.add API
   *
   * @param text - Reminder text
   * @param time - Unix timestamp in seconds when to remind
   * @param userId - Slack user ID to remind
   * @returns Reminder result with ID, or null on failure
   */
  async addReminder(text: string, time: number, userId: string): Promise<ReminderResult | null> {
    try {
      const result = await this.client.reminders.add({
        text,
        time: time.toString(),
        user: userId,
      });

      if (!result.ok || !result.reminder) {
        this.logger.error('Failed to create Slack reminder', {
          userId,
          time,
          error: result.error,
        });
        return null;
      }

      const reminder = result.reminder;
      this.logger.info('Successfully created Slack reminder', {
        reminderId: reminder.id,
        userId,
        time,
      });

      return {
        id: reminder.id ?? '',
        text: reminder.text ?? text,
        time: reminder.time ?? time,
        user: reminder.user ?? userId,
      };
    } catch (error) {
      this.logger.error('Error creating Slack reminder:', error);
      return null;
    }
  }

  // ============================================
  // History Operations
  // ============================================

  /**
   * Fetch recent messages from a Slack channel
   */
  async fetchChannelHistory(channel: string, limit: number = 10): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.history({
        channel,
        limit,
      });

      if (!result.ok) {
        this.logger.error('Failed to fetch Slack channel history');
        return [];
      }

      // Return messages in chronological order (oldest first)
      const messages = (result.messages || []) as SlackMessage[];
      return messages.reverse();
    } catch (error) {
      this.logger.error('Error fetching Slack channel history:', error);
      return [];
    }
  }

  /**
   * Fetch all messages in a time window with pagination support.
   * Based on the working implementation in scripts/liveops-fetch.mjs
   *
   * WARNING: This can fetch thousands of messages for large time windows.
   * Consider the channel volume before using with very long lookback periods.
   *
   * @param channel - Slack channel ID
   * @param oldest - Unix timestamp in seconds (string) for start of window
   * @param latest - Unix timestamp in seconds (string) for end of window (optional, defaults to now)
   */
  async fetchChannelHistoryInTimeWindow(channel: string, oldest: string, latest?: string): Promise<SlackMessage[]> {
    const MAX_PAGES = 100; // Safety limit: 100 pages × 200 messages = 20,000 max
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;
    let pagesProcessed = 0;

    do {
      try {
        const result = await this.client.conversations.history({
          channel,
          oldest,
          ...(latest && { latest }),
          limit: 200, // Slack max per request
          ...(cursor && { cursor }),
        });

        const messages = (result.messages ?? []).map(msg => ({
          ts: msg.ts!,
          text: msg.text ?? '',
          user: msg.user ?? '',
          type: msg.type ?? '',
        }));

        allMessages.push(...messages);
        pagesProcessed++;

        // Handle cursor for pagination
        cursor = result.response_metadata?.next_cursor;
        if (cursor === '') cursor = undefined; // Slack sometimes returns empty string

        // Safety limit to prevent runaway pagination
        if (pagesProcessed >= MAX_PAGES && cursor) {
          this.logger.warn(
            `fetchChannelHistoryInTimeWindow: Hit max pages limit (${MAX_PAGES}). ` +
              `Returning ${allMessages.length} messages, but more exist in the time window.`
          );
          break;
        }
      } catch (error) {
        // If we have partial results, warn and return what we have (matches liveops-fetch.mjs pattern)
        if (allMessages.length > 0) {
          this.logger.error(
            `fetchChannelHistoryInTimeWindow: Pagination failed after ${pagesProcessed} pages ` +
              `(${allMessages.length} messages fetched). Returning partial results.`,
            error instanceof Error ? error.message : error
          );
          break;
        }
        // If no results yet, rethrow
        throw error;
      }
    } while (cursor);

    return allMessages;
  }

  /**
   * Fetch messages from a Slack thread
   * @param channel - Channel ID
   * @param threadTs - Thread timestamp
   * @param includeMetadata - Whether to include message metadata (default: true)
   */
  async fetchThreadHistory(
    channel: string,
    threadTs: string,
    includeMetadata: boolean = true
  ): Promise<SlackMessage[]> {
    try {
      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        include_all_metadata: includeMetadata,
      } as unknown as any); // include_all_metadata may not be in SDK types yet

      if (!result.ok) {
        this.logger.error('Failed to fetch Slack thread history');
        return [];
      }

      // Return messages in chronological order (oldest first)
      return (result.messages || []) as SlackMessage[];
    } catch (error) {
      this.logger.error('Error fetching Slack thread history:', error);
      return [];
    }
  }

  /**
   * Fetch a single message by timestamp with full content
   * Used to get complete message data (including tables, attachments) that
   * the Events API may truncate
   *
   * @param channel - Channel ID
   * @param ts - Message timestamp
   * @returns Full message object or null if not found
   */
  async fetchSingleMessage(channel: string, ts: string): Promise<Record<string, unknown> | null> {
    try {
      const result = await this.client.conversations.history({
        channel,
        latest: ts,
        limit: 1,
        inclusive: true,
      });

      if (!result.ok) {
        this.logger.error('Failed to fetch single Slack message', { channel, ts });
        return null;
      }

      return (result.messages?.[0] as unknown as Record<string, unknown>) || null;
    } catch (error) {
      this.logger.error('Error fetching single Slack message:', error);
      return null;
    }
  }

  // ============================================
  // User Operations
  // ============================================

  /**
   * Get full user information from Slack
   */
  async getUserInfo(userId: string): Promise<SlackUser | null> {
    try {
      const result = await this.client.users.info({
        user: userId,
      });

      if (!result.ok || !result.user) {
        this.logger.error('Failed to fetch Slack user info');
        return null;
      }

      return {
        id: result.user.id || userId,
        name: result.user.name || userId,
        real_name: result.user.real_name,
        email: result.user.profile?.email,
        tz: result.user.tz,
        is_admin: result.user.is_admin,
        is_owner: result.user.is_owner,
      };
    } catch (error) {
      this.logger.error('Error fetching Slack user info:', error);
      return null;
    }
  }

  /**
   * Get just the user's display name from Slack
   * Convenience method that extracts name from getUserInfo
   */
  async getUserName(userId: string): Promise<string> {
    try {
      const userInfo = await this.getUserInfo(userId);

      if (userInfo) {
        return userInfo.real_name || userInfo.name || userId;
      }

      return userId; // Fallback to ID if lookup fails
    } catch (error) {
      this.logger.error('Error fetching Slack user name:', error);
      return userId; // Fallback to ID on error
    }
  }

  /**
   * Get user's timezone from Slack
   * Returns IANA timezone string (e.g., "America/Los_Angeles")
   * Defaults to UTC if timezone is unavailable
   */
  async getUserTimezone(userId: string): Promise<string> {
    const DEFAULT_TIMEZONE = 'UTC';

    try {
      const userInfo = await this.getUserInfo(userId);

      if (userInfo?.tz) {
        return userInfo.tz;
      }

      return DEFAULT_TIMEZONE;
    } catch (error) {
      this.logger.error('Error fetching Slack user timezone:', error);
      return DEFAULT_TIMEZONE;
    }
  }

  // ============================================
  // File Operations
  // ============================================

  /**
   * Upload a file to Slack using the files.uploadV2 API
   */
  async uploadFile(params: UploadFileParams): Promise<FileUploadResult> {
    const { channel, filename, content, threadTs, initialComment } = params;

    this.logger.info('Uploading file to Slack', {
      filename,
      sizeBytes: content.length,
      channel,
    });

    try {
      // Use type assertion to handle optional thread_ts
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uploadArgs: any = {
        channel_id: channel,
        filename,
        file: content,
        initial_comment: initialComment,
      };
      if (threadTs) {
        uploadArgs.thread_ts = threadTs;
      }

      const result = await this.client.files.uploadV2(uploadArgs);

      // files.uploadV2 returns { ok: boolean, files: Array<{ id, name, ... }> }
      const fileResult = result as { ok: boolean; files?: Array<{ id?: string }> };

      if (fileResult.ok && fileResult.files && fileResult.files.length > 0) {
        const uploadedFile = fileResult.files[0];
        this.logger.info('File uploaded to Slack successfully', {
          fileId: uploadedFile.id,
          filename,
        });

        return {
          fileId: uploadedFile.id || '',
          success: true,
        };
      }

      this.logger.warn('File upload returned unexpected response', { result });
      return { fileId: '', success: false };
    } catch (error) {
      this.logger.error('File upload error', { error, filename });
      return { fileId: '', success: false };
    }
  }

  /**
   * Download a file from Slack using url_private
   * Returns file content as Buffer for upload to S3
   */
  async downloadFile(url: string, fileName: string): Promise<Buffer> {
    try {
      this.logger.info('Downloading file from Slack', {
        fileName,
        url: url.substring(0, 50) + '...',
      });

      // Use axios to download file with Slack bot token authorization
      const axios = await import('axios');
      const response = await axios.default.get(url, {
        headers: {
          Authorization: `Bearer ${this.client.token}`,
        },
        responseType: 'arraybuffer',
      });

      const buffer = Buffer.from(response.data);
      this.logger.info('File downloaded successfully', {
        fileName,
        sizeBytes: buffer.length,
      });

      return buffer;
    } catch (error) {
      this.logger.error('Error downloading file from Slack', { error, fileName });
      throw error;
    }
  }

  // ============================================
  // Search Operations
  // ============================================

  /**
   * Search Slack messages
   * Requires user token with search:read scope
   */
  async searchMessages(query: string, count: number = 20, cursor?: string): Promise<SlackSearchResult | null> {
    try {
      this.logger.info('Searching Slack messages', { query, count, cursor });
      const result = await this.client.search.messages({
        query,
        count,
        cursor,
        sort: 'score', // Sort by relevance
        sort_dir: 'desc',
      });

      if (result.ok) {
        this.logger.info('Successfully searched Slack messages', {
          total: result.messages?.total,
          returned: result.messages?.matches?.length,
        });
        return result.messages as unknown as SlackSearchResult;
      }
      return null;
    } catch (error) {
      this.logger.error('Error searching Slack messages:', error);
      throw error;
    }
  }

  // ============================================
  // Channel Management Operations
  // ============================================

  /**
   * Create a new Slack channel
   */
  async createChannel(name: string, isPrivate: boolean = false): Promise<{ id: string; name: string } | null> {
    try {
      this.logger.info('Creating Slack channel', { name, isPrivate });
      const result = await this.client.conversations.create({
        name,
        is_private: isPrivate,
      });

      if (result.ok && result.channel) {
        this.logger.info('Successfully created Slack channel', {
          id: result.channel.id,
          name: result.channel.name,
        });
        return {
          id: result.channel.id || '',
          name: result.channel.name || '',
        };
      }
      return null;
    } catch (error) {
      this.logger.error('Error creating Slack channel:', error);
      throw error;
    }
  }

  /**
   * Archive a Slack channel
   */
  async archiveChannel(channelId: string): Promise<boolean> {
    try {
      this.logger.info('Archiving Slack channel', { channelId });
      const result = await this.client.conversations.archive({
        channel: channelId,
      });

      if (result.ok) {
        this.logger.info('Successfully archived Slack channel', { channelId });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error archiving Slack channel:', error);
      throw error;
    }
  }

  /**
   * Unarchive a Slack channel
   */
  async unarchiveChannel(channelId: string): Promise<boolean> {
    try {
      this.logger.info('Unarchiving Slack channel', { channelId });
      const result = await this.client.conversations.unarchive({
        channel: channelId,
      });

      if (result.ok) {
        this.logger.info('Successfully unarchived Slack channel', { channelId });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error unarchiving Slack channel:', error);
      throw error;
    }
  }

  /**
   * Rename a Slack channel
   */
  async renameChannel(channelId: string, newName: string): Promise<boolean> {
    try {
      this.logger.info('Renaming Slack channel', { channelId, newName });
      const result = await this.client.conversations.rename({
        channel: channelId,
        name: newName,
      });

      if (result.ok) {
        this.logger.info('Successfully renamed Slack channel', { channelId, newName });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error renaming Slack channel:', error);
      throw error;
    }
  }

  /**
   * Set the topic of a Slack channel
   */
  async setChannelTopic(channelId: string, topic: string): Promise<boolean> {
    try {
      this.logger.info('Setting Slack channel topic', { channelId, topic });
      const result = await this.client.conversations.setTopic({
        channel: channelId,
        topic,
      });

      if (result.ok) {
        this.logger.info('Successfully set Slack channel topic', { channelId });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error setting Slack channel topic:', error);
      throw error;
    }
  }

  /**
   * Set the purpose of a Slack channel
   */
  async setChannelPurpose(channelId: string, purpose: string): Promise<boolean> {
    try {
      this.logger.info('Setting Slack channel purpose', { channelId, purpose });
      const result = await this.client.conversations.setPurpose({
        channel: channelId,
        purpose,
      });

      if (result.ok) {
        this.logger.info('Successfully set Slack channel purpose', { channelId });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error setting Slack channel purpose:', error);
      throw error;
    }
  }

  /**
   * Invite users to a Slack channel
   */
  async inviteToChannel(channelId: string, userIds: string[]): Promise<boolean> {
    try {
      this.logger.info('Inviting users to Slack channel', { channelId, userIds });
      const result = await this.client.conversations.invite({
        channel: channelId,
        users: userIds.join(','),
      });

      if (result.ok) {
        this.logger.info('Successfully invited users to Slack channel', { channelId });
        return true;
      }
      return false;
    } catch (error) {
      this.logger.error('Error inviting users to Slack channel:', error);
      throw error;
    }
  }

  // ============================================
  // Reaction Operations
  // ============================================

  /**
   * Add a reaction emoji to a message
   */
  async addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    this.logger.info('Adding reaction to Slack message', {
      channel,
      timestamp,
      emoji,
    });

    try {
      const result = await this.client.reactions.add({
        channel,
        timestamp,
        name: emoji,
      });

      if (result.ok) {
        this.logger.info('Successfully added reaction', { channel, timestamp, emoji });
      }
    } catch (error) {
      this.logger.error('Error adding reaction:', error);
    }
  }

  // ============================================
  // App Home Operations
  // ============================================

  /**
   * Publish a view to the App Home tab for a user
   * @param userId - Slack user ID
   * @param blocks - Block Kit blocks for the home view
   * @returns Success status
   */
  async publishHomeView(userId: string, blocks: (KnownBlock | Block)[]): Promise<boolean> {
    this.logger.info('Publishing App Home view', { userId, blockCount: blocks.length });

    try {
      const result = await this.client.views.publish({
        user_id: userId,
        view: {
          type: 'home',
          blocks: blocks,
        },
      });

      if (result.ok) {
        this.logger.info('Successfully published App Home view', { userId });
        return true;
      } else {
        this.logger.error('Failed to publish App Home view', { userId, error: result.error });
        return false;
      }
    } catch (error) {
      this.logger.error('Error publishing App Home view', { userId, error });
      return false;
    }
  }

  // ============================================
  // Workflow Operations
  // ============================================

  /**
   * Report a failed workflow step execution
   * @param workflowStepExecuteId - The ID of the workflow step execution
   * @param error - The error object containing the message
   */
  async workflowStepFailed(workflowStepExecuteId: string, error: { message: string }): Promise<void> {
    this.logger.info('Reporting workflow step failure', { workflowStepExecuteId, error });

    try {
      await this.client.workflows.stepFailed({
        workflow_step_execute_id: workflowStepExecuteId,
        error: error,
      });
      this.logger.info('Successfully reported workflow step failure');
    } catch (err) {
      this.logger.error('Error reporting workflow step failure:', err);
    }
  }

  /**
   * Report a completed workflow step execution
   * @param workflowStepExecuteId - The ID of the workflow step execution
   * @param outputs - Optional outputs from the step
   * @deprecated Use functionCompleteSuccess for new Workflow Steps API
   */
  async workflowStepCompleted(workflowStepExecuteId: string, outputs?: Record<string, any>): Promise<void> {
    this.logger.info('Reporting workflow step completion', { workflowStepExecuteId });

    try {
      await this.client.workflows.stepCompleted({
        workflow_step_execute_id: workflowStepExecuteId,
        outputs: outputs as unknown as any,
      });
      this.logger.info('Successfully reported workflow step completion');
    } catch (err) {
      this.logger.error('Error reporting workflow step completion:', err);
    }
  }

  // ============================================
  // Function Operations (New Workflow Steps API)
  // ============================================

  /** Errors that should not be retried */
  private static readonly NON_RETRYABLE_ERRORS = [
    'function_execution_not_found',
    'invalid_arguments',
    'execution_not_in_running_state',
  ];

  /**
   * Execute a Slack function API call with retry and exponential backoff
   */
  private async withFunctionRetry(
    operation: () => Promise<{ ok: boolean; error?: string }>,
    context: { functionExecutionId: string; operationName: string },
    maxRetries = 2
  ): Promise<boolean> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await operation();

        if (result.ok) {
          return true;
        }

        // Non-retryable API errors
        if (SlackClient.NON_RETRYABLE_ERRORS.includes(result.error || '')) {
          this.logger.error(`${context.operationName} returned non-retryable error`, {
            functionExecutionId: context.functionExecutionId,
            error: result.error,
          });
          return false;
        }

        lastError = result.error;
        if (attempt < maxRetries) {
          this.logger.warn(`${context.operationName} failed, will retry`, {
            functionExecutionId: context.functionExecutionId,
            error: result.error,
            attempt: attempt + 1,
            maxRetries,
          });
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // Check if thrown error contains a non-retryable error code
        if (SlackClient.NON_RETRYABLE_ERRORS.some(code => errMsg.includes(code))) {
          this.logger.error(`${context.operationName} returned non-retryable error`, {
            functionExecutionId: context.functionExecutionId,
            error: errMsg,
          });
          return false;
        }

        lastError = err;
        if (attempt < maxRetries) {
          this.logger.warn(`${context.operationName} threw error, will retry`, {
            functionExecutionId: context.functionExecutionId,
            error: errMsg,
            attempt: attempt + 1,
            maxRetries,
          });
        }
      }

      // Exponential backoff: 100ms, 200ms, 400ms...
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }

    this.logger.error(`${context.operationName} failed after all retries`, {
      functionExecutionId: context.functionExecutionId,
      error: lastError instanceof Error ? lastError.message : String(lastError),
      totalAttempts: maxRetries + 1,
    });
    return false;
  }

  /**
   * Complete a custom function successfully (new Workflow Steps API)
   * Includes retry with exponential backoff for transient failures
   * @param functionExecutionId - The function_execution_id from the function_executed event
   * @param outputs - Output values matching the function's output_parameters schema
   * @param maxRetries - Maximum number of retry attempts (default: 2)
   */
  async functionCompleteSuccess(
    functionExecutionId: string,
    outputs: Record<string, unknown> = {},
    maxRetries = 2
  ): Promise<boolean> {
    return this.withFunctionRetry(
      () =>
        this.client.functions.completeSuccess({
          function_execution_id: functionExecutionId,
          outputs,
        }),
      { functionExecutionId, operationName: 'Function completion' },
      maxRetries
    );
  }

  /**
   * Complete a custom function with an error (new Workflow Steps API)
   * Includes retry with exponential backoff for transient failures
   * @param functionExecutionId - The function_execution_id from the function_executed event
   * @param errorMessage - User-friendly error message
   * @param maxRetries - Maximum number of retry attempts (default: 2)
   */
  async functionCompleteError(functionExecutionId: string, errorMessage: string, maxRetries = 2): Promise<boolean> {
    return this.withFunctionRetry(
      () =>
        this.client.functions.completeError({
          function_execution_id: functionExecutionId,
          error: errorMessage,
        }),
      { functionExecutionId, operationName: 'Function error report' },
      maxRetries
    );
  }
}
