/**
 * Formats conversation history for Voice session instructions. The OpenAI
 * Realtime API caps instructions at ~4096 characters, so this trims to a
 * budget of recent messages.
 */

import { IChatHistoryItemDocument } from '@bike4mind/common';
import { stripToolOutputMarker } from './artifactParser';
import { historyReplySlots, REPLY_SLOT_SEPARATOR } from './llm/utils';

export interface FormatVoiceHistoryOptions {
  /** Maximum characters for the formatted history (default: 3000) */
  maxChars?: number;
  /** Number of recent messages to include in detail (default: 10) */
  recentMessageCount?: number;
  /** Maximum characters per individual message (default: 300) */
  maxCharsPerMessage?: number;
}

/**
 * Truncate text to a maximum length, adding ellipsis if truncated
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format a single message for voice context
 */
function formatMessage(role: 'user' | 'assistant', content: string, maxChars: number): string {
  const truncated = truncateText(content.trim(), maxChars);
  return `${role === 'user' ? 'User' : 'Assistant'}: ${truncated}`;
}

/**
 * Joins a turn's reply slots within maxChars. Over budget, the last slot (the final answer) is kept
 * whole and only the earlier narration is cut, so a long tool preamble cannot crowd the answer out.
 */
function fitReplySlots(slots: string[], maxChars: number): string {
  const joined = stripToolOutputMarker(slots.join(REPLY_SLOT_SEPARATOR)).trim();
  if (joined.length <= maxChars || slots.length < 2) return joined;

  const answer = stripToolOutputMarker(slots[slots.length - 1]).trim();
  const leadBudget = maxChars - answer.length - REPLY_SLOT_SEPARATOR.length;
  if (leadBudget <= 3) return answer;

  const lead = stripToolOutputMarker(slots.slice(0, -1).join(REPLY_SLOT_SEPARATOR)).trim();
  return truncateText(lead, leadBudget) + REPLY_SLOT_SEPARATOR + answer;
}

/**
 * Format conversation history for Voice session instructions.
 *
 * Strategy:
 * - Include the most recent N messages in detail
 * - Truncate individual messages to prevent any single message from dominating
 * - Add context header explaining the history is available
 * - Respect the overall character limit for OpenAI Realtime API
 *
 * @param historyItems - Chat history items in chronological order (oldest first).
 *   NOTE: Callers must ensure correct ordering. If using getMostRecentChatHistory
 *   (which returns newest first), reverse the array before passing to this function.
 * @param options - Formatting options
 * @returns Formatted history string for the instructions parameter, or empty string
 *   if no history items. Empty string can be safely concatenated with base instructions.
 */
export function formatVoiceHistory(
  historyItems: IChatHistoryItemDocument[],
  options: FormatVoiceHistoryOptions = {}
): string {
  const { maxChars = 3000, recentMessageCount = 10, maxCharsPerMessage = 300 } = options;

  if (!historyItems || historyItems.length === 0) {
    return '';
  }

  // Most recent items; caller must pass chronological order (oldest first).
  const recentItems = historyItems.slice(-recentMessageCount);

  const lines: string[] = [
    '\n\nCONVERSATION CONTEXT:',
    'You are continuing a conversation with this user. Here is the recent chat history:',
    '',
  ];

  for (const item of recentItems) {
    if (item.prompt) {
      lines.push(formatMessage('user', item.prompt, maxCharsPerMessage));
    }

    // A tool turn's first slot is only its pre-tool preamble, so every non-thinking slot is kept.
    const reply = Array.isArray(item.replies) ? fitReplySlots(historyReplySlots(item), maxCharsPerMessage) : '';
    if (reply) {
      lines.push(formatMessage('assistant', reply, maxCharsPerMessage));
    }
  }

  lines.push('');
  lines.push('Use this context to maintain continuity. Reference previous topics naturally when relevant.');

  let result = lines.join('\n');
  if (result.length > maxChars) {
    result = truncateText(result, maxChars);
  }

  return result;
}

/**
 * Build complete voice session instructions with history context
 *
 * @param baseInstructions - Base system prompt for the voice assistant
 * @param historyContext - Formatted history from formatVoiceHistory. If empty string
 *   (no history), returns baseInstructions unchanged.
 * @returns Complete instructions string for OpenAI Realtime API
 */
export function buildVoiceInstructions(baseInstructions: string, historyContext: string): string {
  if (!historyContext) {
    return baseInstructions;
  }

  return `${baseInstructions}${historyContext}`;
}
