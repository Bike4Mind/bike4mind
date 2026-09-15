import { IChatHistoryItem } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import { getSlackDeps, getSlackDb } from '../di/registry';
import { CommandHandler } from '../CommandHandler';
import { createLoadingBar } from '../utils/loadingBar';
import { processMarkdownForSlack } from '../utils/slackMarkdown';

/**
 * Split text that exceeds the limit at word boundaries.
 * Falls back to hard character split if no space is found.
 */
export function splitLongText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split at a space before the limit
    let splitIndex = remaining.lastIndexOf(' ', limit);
    if (splitIndex <= 0) {
      // No space found - hard split at limit
      splitIndex = limit;
    }
    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

const BLOCK_CHAR_LIMIT = 11900;
const MAX_CONTENT_BLOCKS = 45;

/**
 * Split text into Slack Block Kit markdown blocks, respecting character and block limits.
 * Splits at line boundaries to preserve Markdown formatting (headers, bullets, links, etc.).
 */
export function splitTextIntoBlocks(
  text: string,
  limit: number = BLOCK_CHAR_LIMIT,
  maxBlocks: number = MAX_CONTENT_BLOCKS
): { blocks: Array<{ type: 'markdown'; text: string }>; truncated: boolean } {
  if (text.length <= limit) {
    return { blocks: [{ type: 'markdown', text }], truncated: false };
  }

  const blocks: Array<{ type: 'markdown'; text: string }> = [];
  const lines = text.split('\n');
  let currentChunk = '';
  let hitBlockLimit = false;

  for (const line of lines) {
    if (hitBlockLimit) break;

    if (line.length > limit) {
      if (currentChunk.trim()) {
        if (blocks.length >= maxBlocks) {
          hitBlockLimit = true;
          break;
        }
        blocks.push({ type: 'markdown', text: currentChunk.trimEnd() });
        currentChunk = '';
      }
      for (const subBlock of splitLongText(line, limit)) {
        if (blocks.length >= maxBlocks) {
          hitBlockLimit = true;
          break;
        }
        blocks.push({ type: 'markdown', text: subBlock });
      }
      continue;
    }

    if (currentChunk.length + line.length + 1 > limit && currentChunk.length > 0) {
      if (blocks.length >= maxBlocks) {
        hitBlockLimit = true;
        break;
      }
      blocks.push({ type: 'markdown', text: currentChunk.trimEnd() });
      currentChunk = '';
    }
    currentChunk += (currentChunk ? '\n' : '') + line;
  }

  if (currentChunk.trim() && !hitBlockLimit && blocks.length < maxBlocks) {
    blocks.push({ type: 'markdown', text: currentChunk.trimEnd() });
  }
  if (hitBlockLimit) {
    blocks.push({ type: 'markdown', text: '_… response truncated due to Slack message limits_' });
  }

  return { blocks, truncated: hitBlockLimit };
}

/** Return type for formatAgentResponse. */
export interface FormattedAgentResponse {
  blocks: any[];
}

// Helper function to format agent response with Slack Block Kit.
// Converts Markdown tables into bullet lists via AST processing so Slack renders them cleanly.
export function formatAgentResponse(agentName: string, response: string, toolsUsed?: string[]): FormattedAgentResponse {
  const blocks: any[] = [];

  // Agent header with emoji based on agent type
  const agentEmoji =
    {
      pm: '📋',
      dev: '💻',
      analyst: '📊',
      researcher: '🔍',
      agent: '🤖',
    }[agentName] || '🤖';

  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: `${agentEmoji} ${agentName === 'agent' ? 'AI Assistant' : agentName.toUpperCase()} Response`,
      emoji: true,
    },
  });

  // Process Markdown: convert tables to bullet lists for Slack rendering
  const { text } = processMarkdownForSlack(response);

  // Main response content - split across multiple markdown blocks for long responses.
  const { blocks: contentBlocks } = splitTextIntoBlocks(text);
  blocks.push(...contentBlocks);

  // If tools were used, show them in context
  if (toolsUsed && toolsUsed.length > 0) {
    blocks.push({
      type: 'context',
      elements: toolsUsed.map(tool => ({
        type: 'mrkdwn',
        text: `✓ Used: ${tool}`,
      })),
    });
  }

  blocks.push({ type: 'divider' });

  return { blocks };
}

// Helper function to send message to notebook and get AI response with channel context and status updates
export async function sendMessageToNotebookAndGetResponse(
  sessionId: string,
  userId: string,
  text: string,
  systemPrompt: string,
  logger: Logger,
  commandHandler: CommandHandler,
  statusCallback?: (status: string) => Promise<void>,
  fabFileIds: string[] = [],
  slackNotification?: {
    workspaceId: string;
    channelId: string;
    threadTs: string;
    messageTs: string;
  },
  returnEarly: boolean = false, // If true, don't wait for AI - Quest Processor will handle response
  additionalTools: string[] = [] // Extra tools to enable (e.g., confirm/cancel pending action)
): Promise<string | null> {
  // Update status: Saving to notebook
  if (statusCallback) await statusCallback(`${createLoadingBar(10)} Saving to notebook...`);

  // First, add the user's message to the session (this creates a quest)
  const message: Omit<IChatHistoryItem, 'sessionId'> = {
    timestamp: new Date(),
    type: 'message',
    prompt: text,
  };

  const { User, Quest, defineAbilitiesFor } = getSlackDb();
  const { sessionManager } = getSlackDeps();

  const user = await (User as any).findById(userId);
  if (!user) throw new Error('User not found');

  const ability = (defineAbilitiesFor as any)(user);
  const createdQuest = await sessionManager.addMessageToSession(userId, sessionId, message, ability);

  // Store slackNotification on the Quest before triggering AI so Quest Processor can edit
  // the message even if the Frontend Lambda times out.
  if (slackNotification) {
    await (Quest as any).findByIdAndUpdate(createdQuest.id, { slackNotification });
    logger.debug('🔔 [ASYNC-NOTIFY] Stored slackNotification on Quest for async editing', {
      questId: createdQuest.id,
      messageTs: slackNotification.messageTs,
    });
  }

  // For large tables: trigger AI but don't wait for completion - Quest Processor will edit message
  if (returnEarly) {
    logger.debug('🔔 [ASYNC-NOTIFY] Triggering AI (async mode) - Quest Processor will handle response', {
      questId: createdQuest.id,
    });
    // CRITICAL: Must await the EventBridge publish, but skip polling for completion
    // Lambda kills pending promises when handler returns, so fire-and-forget doesn't work!
    // waitForCompletion=false: returns immediately after EventBridge publish (before polling)
    await commandHandler.triggerAIResponseWithContext(
      sessionId,
      text,
      systemPrompt,
      undefined, // No status callback - we're returning early
      fabFileIds,
      createdQuest.id,
      false, // Don't wait for completion - Quest Processor handles the rest
      additionalTools
    );
    logger.debug('🔔 [ASYNC-NOTIFY] AI triggered successfully, returning early', {
      questId: createdQuest.id,
    });
    return null; // Return null to signal early return
  }

  // Legacy path: ChatCompletionInvoke -> EventBridge -> Quest Processor -> polling.
  // When targetSystem is set (MCP queries) the Quest Processor can take 60s+, past the
  // frontend Lambda's 60s limit, so keep slackNotification on the Quest and let the
  // Quest Processor edit the Slack message directly when it finishes.

  const aiResponse = await commandHandler.triggerAIResponseWithContext(
    sessionId,
    text,
    systemPrompt,
    statusCallback,
    fabFileIds,
    createdQuest.id, // Pass the quest ID to use the existing quest instead of creating a new one
    true, // waitForCompletion
    additionalTools
  );
  return aiResponse;
}
