import { isTurnBudgetStop, type ChatMessage, type ChatSession, type ChatSessionSummary } from './chat';

/**
 * How a spawned session ended, classified once for the two audiences that read it.
 *
 * The parent model and the user are told different things about the same event - see
 * ChatService.describeChildOutcome for the model's half and `childOutcomeDisplay` for the
 * user's - and the two must never disagree about WHICH of these happened. So the branching
 * lives here and the wording lives in the callers.
 */
export type ChildOutcome =
  /** It answered and stopped on its own. */
  | 'finished'
  /** The run ended with no assistant turn in it at all. */
  | 'no-reply'
  /** Its last turn failed. */
  | 'failed'
  /** The agent loop's own budget ran out mid-task. See isTurnBudgetStop. */
  | 'turn-budget'
  /** It filled the model context. */
  | 'context-limit'
  /** The reply hit the length limit. */
  | 'max-tokens'
  /** Someone pressed stop. */
  | 'aborted';

/** Only the last assistant turn decides: an earlier failure that a later turn recovered from does not count. */
export function classifyMessagesOutcome(messages: readonly ChatMessage[]): ChildOutcome {
  const last = [...messages].reverse().find(message => message.role === 'assistant');
  if (!last) return 'no-reply';
  if (last.error) return 'failed';
  if (isTurnBudgetStop(last.stopReason)) return 'turn-budget';
  if (last.stopReason === 'context_limit') return 'context-limit';
  if (last.stopReason === 'max_tokens') return 'max-tokens';
  if (last.stopReason === 'aborted') return 'aborted';
  return 'finished';
}

export const SNIPPET_MAX = 160;

/** One line of `text` for a roster row: whitespace collapsed, cut to `max` characters with a trailing '...'. */
export function snippetOf(text: string, max: number = SNIPPET_MAX): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 3))}...`;
}

/**
 * A session's sidebar and roster summary. The one place it is built, shared by main's SessionStore
 * and the renderer's own push after a send, so neither drops the derived fields.
 */
export function summarizeSession(session: ChatSession): ChatSessionSummary {
  const { messages, spawnSuggestions: _suggestions, ...summary } = session;
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const lastSnippet = lastAssistant ? snippetOf(plainText(closingText(lastAssistant))) : '';
  const totalUsdCost = sumUsage(messages, 'usdCost');
  const totalCredits = sumUsage(messages, 'creditsUsed');
  return {
    ...summary,
    messageCount: messages.length,
    ...(lastAssistant ? { lastOutcome: classifyMessagesOutcome(messages) } : {}),
    ...(lastSnippet ? { lastSnippet } : {}),
    ...(totalUsdCost !== undefined ? { totalUsdCost } : {}),
    ...(totalCredits !== undefined ? { totalCredits } : {}),
  };
}

/**
 * The prose a reply ended on. A tool-using reply's `content` opens with its first round's narration
 * ("Let me look at..."), so the last round that said anything is where its result is.
 */
function closingText(message: ChatMessage): string {
  const spoken = message.rounds?.filter(round => round.text.trim() !== '');
  return spoken?.length ? spoken[spoken.length - 1].text : message.content;
}

/** Markdown syntax that reads as noise in a one-line excerpt: headings, emphasis, code ticks, links, list and quote markers. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/`([^`\n]*)`/g, '$1');
}

/** Sum of one usage field over every message, or undefined when no message reported it. */
function sumUsage(messages: readonly ChatMessage[], field: 'usdCost' | 'creditsUsed'): number | undefined {
  let total: number | undefined;
  for (const message of messages) {
    const value = message.usage?.[field];
    if (typeof value === 'number') total = (total ?? 0) + value;
  }
  return total;
}
