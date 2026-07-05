import { ISlackDevWorkspaceDocument, IUserDocument } from '@bike4mind/common';
import { findUserBySlackId } from './handlers/user-lookup';
import { SlackClient } from './SlackClient';
import { Logger } from '@bike4mind/observability';
import { getSlackDb } from './di/registry';
import { SlackMessageEnricher } from './SlackMessageEnricher';

/**
 * Slack rich text element types
 */
export interface SlackRichTextElement {
  type: string;
  text?: string;
  elements?: SlackRichTextElement[];
  style?: {
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  };
}

/**
 * Slack block types for rich text content
 */
export interface SlackBlock {
  type: string;
  block_id?: string;
  elements?: SlackRichTextElement[];
}

export interface SlackEventData {
  type: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  app_mention?: boolean;
  bot_id?: string;
  files?: Array<{
    id: string;
    // These fields are normally present but Slack may omit them for edge-case
    // events (e.g. pending/deleted files). Treat them as optional so the event
    // is not rejected; callers must guard before using them.
    name?: string;
    mimetype?: string;
    url_private?: string;
    url_private_download?: string;
    filetype?: string;
    size?: number;
    title?: string;
  }>;
  // Slack blocks contain rich text content including tables, code blocks, etc.
  blocks?: SlackBlock[];
  // Slack attachments can contain formatted content like tables
  attachments?: Array<{
    id?: number;
    fallback?: string;
    text?: string;
    pretext?: string;
    title?: string;
    fields?: Array<{
      title: string;
      value: string;
      short?: boolean;
    }>;
  }>;
}

/**
 * System message subtypes that should be ignored
 */
const IGNORED_SUBTYPES = [
  'channel_join',
  'channel_leave',
  'bot_add',
  'bot_remove',
  'channel_topic',
  'channel_purpose',
  'channel_name',
];

/**
 * SlackEvent wraps Slack event data with helper methods for common operations
 */
export class SlackEvent {
  private eventData: SlackEventData;
  private workspace?: ISlackDevWorkspaceDocument;
  private enrichedText?: string;
  private wasEnriched: boolean = false;
  private logger?: Logger;

  constructor(eventData: SlackEventData, workspace?: ISlackDevWorkspaceDocument) {
    this.eventData = eventData;
    this.workspace = workspace;
  }

  /**
   * Enrich message text by fetching full content from Slack's Web API.
   * The Events API truncates table data, so call this before accessing .text
   * when you need full table content.
   *
   * @param slackClient - SlackClient instance for API calls
   * @param logger - Optional logger instance
   * @returns Object with enrichment result details
   */
  async enrichMessageContent(
    slackClient: SlackClient,
    logger?: Logger
  ): Promise<{ wasEnriched: boolean; tableCount: number }> {
    this.logger = logger;

    if (this.wasEnriched) {
      return { wasEnriched: true, tableCount: 0 };
    }

    const baseText = this.getBaseText();

    // Events API omits rich table data pasted from spreadsheets, so always fetch
    // the full message to check for table attachments.
    const enricher = new SlackMessageEnricher(slackClient, logger);
    const result = await enricher.enrichMessageText(this.channel, this.ts, baseText);

    if (result.wasEnriched) {
      this.enrichedText = result.text;
      this.wasEnriched = true;
      logger?.info('[ENRICHER] Successfully enriched message with table data', {
        originalLength: baseText.length,
        enrichedLength: result.text.length,
        tableCount: result.tableCount,
      });
    }

    return { wasEnriched: result.wasEnriched, tableCount: result.tableCount };
  }

  /**
   * Get base text without enrichment (from Events API data)
   */
  private getBaseText(): string {
    let text = this.eventData.text || '';
    const originalTextLength = text.length;

    // Slack sends tables and long content in blocks; extract and append that text.
    if (this.eventData.blocks && this.eventData.blocks.length > 0) {
      this.logger?.info(`[SLACK-BLOCKS] Found ${this.eventData.blocks.length} blocks in message`);

      const blockText = this.extractTextFromBlocks(this.eventData.blocks);

      if (blockText) {
        this.logger?.info(
          `[SLACK-BLOCKS] Extracted ${blockText.length} chars from blocks (original text: ${originalTextLength} chars)`
        );

        if (blockText !== text) {
          const previousLength = text.length;
          text = text ? `${text}\n\n${blockText}` : blockText;
          this.logger?.info(
            `[SLACK-BLOCKS] Appended block content. Text expanded from ${previousLength} to ${text.length} chars`
          );
        } else {
          this.logger?.info(`[SLACK-BLOCKS] Block text matches original text, no expansion needed`);
        }
      } else {
        this.logger?.info(`[SLACK-BLOCKS] No text extracted from blocks`);
      }
    }

    if (this.eventData.attachments && this.eventData.attachments.length > 0) {
      this.logger?.info(`[SLACK-ATTACHMENTS] Found ${this.eventData.attachments.length} attachments in message`);

      const attachmentText = this.extractTextFromAttachments(this.eventData.attachments);

      if (attachmentText) {
        this.logger?.info(`[SLACK-ATTACHMENTS] Extracted ${attachmentText.length} chars from attachments`);

        if (!text.includes(attachmentText)) {
          const previousLength = text.length;
          text = text ? `${text}\n\n${attachmentText}` : attachmentText;
          this.logger?.info(
            `[SLACK-ATTACHMENTS] Appended attachment content. Text expanded from ${previousLength} to ${text.length} chars`
          );
        }
      }
    }

    return text;
  }

  // Core Properties

  get type(): string {
    return this.eventData.type;
  }

  get channel(): string {
    return this.eventData.channel || '';
  }

  get user(): string {
    return this.eventData.user || '';
  }

  get text(): string {
    if (this.enrichedText) {
      return this.enrichedText;
    }

    return this.getBaseText();
  }

  /**
   * Extract text from Slack attachments
   */
  private extractTextFromAttachments(attachments: NonNullable<SlackEventData['attachments']>): string {
    const textParts: string[] = [];

    for (const attachment of attachments) {
      if (attachment.pretext) {
        textParts.push(attachment.pretext);
      }

      if (attachment.title) {
        textParts.push(attachment.title);
      }

      if (attachment.text) {
        textParts.push(attachment.text);
      }

      // Add fallback (often contains full content)
      if (attachment.fallback && !textParts.includes(attachment.fallback)) {
        textParts.push(attachment.fallback);
      }

      // Add fields (often used for table-like data)
      if (attachment.fields && attachment.fields.length > 0) {
        for (const field of attachment.fields) {
          textParts.push(`${field.title}: ${field.value}`);
        }
      }
    }

    return textParts.join('\n');
  }

  /**
   * Extract plain text from Slack blocks (rich_text, section, etc.)
   * This is needed because Slack sends tables and long content in blocks
   * rather than in the plain text field
   */
  private extractTextFromBlocks(blocks: SlackBlock[]): string {
    const textParts: string[] = [];

    for (const block of blocks) {
      if (block.type === 'rich_text' && block.elements) {
        for (const element of block.elements) {
          const elementText = this.extractTextFromRichTextElement(element);
          if (elementText) {
            textParts.push(elementText);
          }
        }
      } else if (block.type === 'section' && block.elements) {
        // Section blocks can also contain text
        for (const element of block.elements) {
          if (element.text) {
            textParts.push(element.text);
          }
        }
      }
    }

    return textParts.join('\n');
  }

  /**
   * Recursively extract text from rich text elements
   * Handles nested elements like rich_text_section, rich_text_list, rich_text_preformatted
   */
  private extractTextFromRichTextElement(element: SlackRichTextElement): string {
    // If element has direct text, return it
    if (element.text) {
      return element.text;
    }

    // If element has nested elements, recursively extract
    if (element.elements && element.elements.length > 0) {
      const texts: string[] = [];
      for (const child of element.elements) {
        const childText = this.extractTextFromRichTextElement(child);
        if (childText) {
          texts.push(childText);
        }
      }

      // For list items, join with newlines; for others, join without separator
      if (element.type === 'rich_text_list') {
        return texts.map(t => `• ${t}`).join('\n');
      }
      return texts.join('');
    }

    return '';
  }

  get ts(): string {
    return this.eventData.ts;
  }

  get threadTs(): string | undefined {
    return this.eventData.thread_ts;
  }

  get subtype(): string | undefined {
    return this.eventData.subtype;
  }

  get botId(): string | undefined {
    return this.eventData.bot_id;
  }

  get files(): NonNullable<SlackEventData['files']> {
    return this.eventData.files || [];
  }

  // Derived Properties

  /**
   * Check if this event has file attachments
   */
  get hasFiles(): boolean {
    return !!this.eventData.files && this.eventData.files.length > 0;
  }

  /**
   * Check if this event is in a thread
   */
  get isThreaded(): boolean {
    return !!this.eventData.thread_ts;
  }

  /**
   * Check if this is a direct message (DM)
   */
  get isDM(): boolean {
    return this.channel.startsWith('D');
  }

  /**
   * Check if this is a regular channel message
   */
  get isChannelMessage(): boolean {
    return this.channel.startsWith('C');
  }

  /**
   * Check if this message was sent by a bot
   */
  get isBotMessage(): boolean {
    return !!this.eventData.bot_id || this.user === 'USLACKBOT';
  }

  // Message Parsing

  /**
   * Extract @user mentions from message text
   * Returns array of Slack user IDs (e.g., ['U12345', 'U67890'])
   */
  getMentions(): string[] {
    const mentionPattern = /<@([A-Z0-9]+)>/g;
    const mentions: string[] = [];
    let match;

    while ((match = mentionPattern.exec(this.text)) !== null) {
      mentions.push(match[1]);
    }

    return mentions;
  }

  /**
   * Extract @bot mentions from message text
   * Similar to getMentions() but specifically for bots
   */
  getBotMentions(): string[] {
    // Same as getMentions for now; could later filter for bot IDs specifically.
    return this.getMentions();
  }

  /**
   * Get message text with all mentions removed
   */
  getCleanedText(): string {
    return this.text.replace(/<@[^>]+>/g, '').trim();
  }

  /**
   * Check if message contains a mention of a specific bot
   */
  containsBotMention(botUserId: string): boolean {
    if (!botUserId) return false;
    return this.text.includes(`<@${botUserId}>`);
  }

  /**
   * Check if message contains bot mention from workspace config
   */
  containsWorkspaceBotMention(): boolean {
    if (!this.workspace?.slackBotUserId) return false;
    return this.containsBotMention(this.workspace.slackBotUserId);
  }

  // User Operations

  /**
   * Get the internal user (from database) by Slack ID
   * Returns null if user is not linked
   */
  async getInternalUser(): Promise<IUserDocument | null> {
    if (!this.user) return null;
    return findUserBySlackId(this.user);
  }

  /**
   * Get the Slack username for this event's user
   * Requires SlackClient instance to make API call
   */
  async getUserName(slackClient: SlackClient): Promise<string> {
    if (!this.user) return 'Unknown User';
    return slackClient.getUserName(this.user);
  }

  // Thread Operations

  /**
   * Get the thread timestamp for replies
   * Uses thread-first strategy: if already in thread, use thread_ts
   * Otherwise, use the message ts to start a new thread
   */
  getReplyThreadTs(): string {
    return this.eventData.thread_ts || this.eventData.ts;
  }

  // Event Type Checks

  /**
   * Check if this is an app mention event
   */
  isAppMention(): boolean {
    return this.type === 'app_mention';
  }

  /**
   * Check if this is a regular message event
   */
  isRegularMessage(): boolean {
    return this.type === 'message' && !this.subtype;
  }

  /**
   * Check if this is a system message (channel_join, etc.)
   */
  isSystemMessage(): boolean {
    return !!this.subtype && IGNORED_SUBTYPES.includes(this.subtype);
  }

  /**
   * Check if message was already processed (using MongoDB for cross-instance deduplication)
   *
   * Deduplication settings:
   * - 5 minute window to handle Slack retries during long-running AI requests
   * - Slack retries events at ~60s, 120s, 180s if no acknowledgment received
   *
   * @param eventId - Slack event ID for tracking
   * @param logger - Optional logger instance
   * @returns true if message was already processed, false otherwise
   */
  private async isMessageAlreadyProcessed(eventId: string, logger?: Logger): Promise<boolean> {
    const MESSAGE_DEDUP_WINDOW = 300000; // 5 minutes in milliseconds
    const dedupKey = `slack-dedup-${this.channel}-${this.user}-${this.ts}`;

    try {
      const { cacheRepository } = getSlackDb();
      const existing = await (cacheRepository as any).findByKey(dedupKey);

      if (existing && existing.expiresAt > new Date()) {
        logger?.warn('[DEDUP] Duplicate detected — blocking', {
          dedupKey,
          eventId,
        });
        return true;
      }

      const expiresAt = new Date(Date.now() + MESSAGE_DEDUP_WINDOW);
      await (cacheRepository as any).createOrUpdate({
        key: dedupKey,
        result: {
          processedAt: new Date(),
          channel: this.channel,
          userId: this.user,
          messageTs: this.ts,
          eventId,
          eventType: this.type,
          processId: process.pid,
        },
        expiresAt,
      });

      return false;
    } catch (error) {
      logger?.error('❌ [DEDUP ERROR] Error checking message deduplication:', error);
      // If deduplication check fails, allow the message through to avoid blocking legitimate requests
      // This is safer than risking duplicate processing
      return false;
    }
  }

  /**
   * Determine if this event should be processed
   * Combines all filtering logic AND deduplication check:
   * - Must have user, text, and channel
   * - Not a bot message
   * - Not a system message
   * - Meets processing criteria (DM, thread with command, channel with mention/command)
   * - Not a duplicate message (checked via MongoDB cache)
   *
   * @param eventId - Slack event ID for deduplication tracking
   * @param agentCommandPattern - Optional regex pattern for agent commands
   * @param logger - Optional logger instance for debugging
   * @returns Object with shouldProcess boolean and reason string
   */
  async shouldProcess(
    eventId: string,
    agentCommandPattern?: RegExp,
    logger?: Logger
  ): Promise<{ shouldProcess: boolean; reason: string }> {
    // Must have a timestamp (non-message events like app_home_opened don't have ts)
    if (!this.ts) {
      return { shouldProcess: false, reason: 'No timestamp (not a message event)' };
    }

    if (!this.user || !this.text || !this.channel) {
      return { shouldProcess: false, reason: 'Missing required fields (user, text, or channel)' };
    }

    if (this.isBotMessage) {
      return { shouldProcess: false, reason: 'Bot message' };
    }

    if (this.isSystemMessage()) {
      return { shouldProcess: false, reason: 'System message' };
    }

    let passesBasicChecks = false;

    // App mentions always process
    if (this.isAppMention()) {
      passesBasicChecks = true;
    }
    // DMs always process
    else if (this.isDM) {
      passesBasicChecks = true;
    }
    // For regular messages in channels/threads, check for an agent command.
    // Do NOT handle bot mentions here - app_mention events handle those, to avoid
    // duplicate processing (Slack sends both message and app_mention for @mentions).
    else if (this.type === 'message') {
      // app_mention event will handle bot mentions
      if (this.containsWorkspaceBotMention()) {
        return { shouldProcess: false, reason: 'Bot mention in message event (will be handled by app_mention)' };
      }

      if (agentCommandPattern && agentCommandPattern.test(this.text)) {
        passesBasicChecks = true;
      }
    }

    if (!passesBasicChecks) {
      return { shouldProcess: false, reason: 'Does not meet processing criteria' };
    }

    const isDuplicate = await this.isMessageAlreadyProcessed(eventId, logger);
    if (isDuplicate) {
      return { shouldProcess: false, reason: 'Duplicate message already processed' };
    }

    return { shouldProcess: true, reason: 'New message, ready to process' };
  }

  /**
   * Get a human-readable description of this event
   * Useful for logging and debugging
   */
  getDescription(): string {
    const parts: string[] = [];

    parts.push(`Type: ${this.type}`);

    if (this.subtype) {
      parts.push(`Subtype: ${this.subtype}`);
    }

    if (this.isDM) {
      parts.push('DM');
    } else if (this.isThreaded) {
      parts.push('Thread');
    } else {
      parts.push('Channel');
    }

    if (this.isBotMessage) {
      parts.push('Bot');
    }

    if (this.text) {
      parts.push(`Text: "${this.text.substring(0, 50)}${this.text.length > 50 ? '...' : ''}"`);
    }

    return parts.join(' | ');
  }
}
