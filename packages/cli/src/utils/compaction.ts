import { v4 as uuidv4 } from 'uuid';
import type { Message, Session } from '../storage/types.js';
import { buildHandoffSystemMessage } from './handoff.js';

export interface CompactionOptions {
  /** Number of recent exchanges (user+assistant pairs) to preserve without summarizing (default: 2) */
  preserveRecentExchanges?: number;
  /** User-provided instructions for what to focus on in the summary */
  userInstructions?: string;
  /** Project-specific instructions from CLAUDE.md "# Compact Instructions" section */
  claudeMdInstructions?: string;
}

export interface CompactionPromptResult {
  /** The prompt to send to the LLM for summarization */
  prompt: string;
  /** Messages that will be preserved in the new session (not summarized) */
  preservedMessages: Message[];
}

/**
 * Build a prompt for the LLM to summarize the conversation.
 *
 * Preserves the most recent exchanges to maintain conversational flow,
 * while summarizing older messages to reduce context size.
 *
 * @param messages - All messages in the current session
 * @param options - Compaction options
 * @returns The summarization prompt and messages to preserve
 */
export function buildCompactionPrompt(messages: Message[], options: CompactionOptions = {}): CompactionPromptResult {
  const preserveCount = (options.preserveRecentExchanges ?? 2) * 2;

  // If not enough messages, preserve all
  if (messages.length <= preserveCount) {
    return {
      prompt: '',
      preservedMessages: messages,
    };
  }

  const messagesToSummarize = messages.slice(0, -preserveCount);
  const preservedMessages = messages.slice(-preserveCount);

  let prompt = `You are summarizing a conversation for context continuity. Create a concise summary that captures:

- Key decisions made
- Important context established
- Files and code discussed
- Current task state
- Any pending items or next steps

`;

  if (options.claudeMdInstructions) {
    prompt += `Project-specific compaction instructions:\n${options.claudeMdInstructions}\n\n`;
  }

  if (options.userInstructions) {
    prompt += `Additional focus: ${options.userInstructions}\n\n`;
  }

  prompt += `CONVERSATION TO SUMMARIZE:\n\n`;

  const roleLabels: Record<string, string> = {
    user: 'User',
    assistant: 'Assistant',
    system: 'System',
  };

  for (const msg of messagesToSummarize) {
    const roleLabel = roleLabels[msg.role] || 'System';
    // Truncate very long messages for the summary prompt
    const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...[truncated]' : msg.content;
    prompt += `**${roleLabel}:** ${content}\n\n`;
  }

  prompt += `\nProvide a concise summary (aim for 500-1000 words) that an AI assistant can use to continue this conversation with full context.`;

  return { prompt, preservedMessages };
}

/**
 * Create a new compacted session from an original session.
 *
 * The new session contains:
 * 1. A system message with the conversation summary
 * 2. The preserved recent messages
 *
 * @param originalSession - The session being compacted
 * @param summary - The LLM-generated summary of older messages
 * @param preservedMessages - Recent messages to keep verbatim
 * @returns A new session with compacted context
 */
export function createCompactedSession(
  originalSession: Session,
  summary: string,
  preservedMessages: Message[],
  /**
   * When true, the compacted session keeps the original session's uuid instead of
   * minting a new one. Used in host pinned-session mode so the host's --resume
   * still finds this conversation after a /compact.
   */
  preserveId = false
): Session {
  // Stored as a `user` role (not `system`) so it survives the
  // user/assistant filter applied to `previousMessages` before each agent run.
  const summaryMessage: Message = {
    id: uuidv4(),
    role: 'user',
    content: `[Previous conversation summary]\n\n${summary}`,
    timestamp: new Date().toISOString(),
  };

  // Stored as `user` (not `system`) for the same reason as the summary
  // message above - system messages get filtered out before `agent.run`.
  const handoff = originalSession.metadata.workflow?.handoff;
  const handoffMessage: Message | null = handoff
    ? {
        id: uuidv4(),
        role: 'user',
        content: buildHandoffSystemMessage(handoff),
        timestamp: new Date().toISOString(),
      }
    : null;

  const messages: Message[] = handoffMessage
    ? [handoffMessage, summaryMessage, ...preservedMessages]
    : [summaryMessage, ...preservedMessages];

  return {
    id: preserveId ? originalSession.id : uuidv4(),
    name: `${originalSession.name} (compacted)`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: originalSession.model,
    messages,
    metadata: {
      totalTokens: 0,
      totalCost: 0,
      toolCallCount: 0,
      compactedFrom: originalSession.id,
      ...(originalSession.metadata.workflow ? { workflow: originalSession.metadata.workflow } : {}),
    },
  };
}
