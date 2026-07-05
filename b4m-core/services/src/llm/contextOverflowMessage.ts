/**
 * Token sources tracked when a request overflows the model context window.
 * Mirrors the `tokensBySource` breakdown computed in ChatCompletionProcess.
 */
export type TokenSource =
  | 'systemPrompts'
  | 'conversationHistory'
  | 'mementos'
  | 'fabFiles'
  | 'urlContent'
  | 'toolSchemas'
  | 'userPrompt';

export interface ContextOverflowMessageParams {
  /** Human-readable model name (e.g. "Claude 4.5 Sonnet"). */
  modelName: string;
  inputTokens: number;
  maxSafeInputTokens: number;
  /** Per-source token counts; may be unavailable if breakdown calculation failed. */
  tokensBySource?: Partial<Record<TokenSource, number>> | null;
  /** Used only for the fallback line when tokensBySource is unavailable. */
  messageCount?: number;
  mementoCount?: number;
}

/**
 * A source dominates the context when it accounts for at least this fraction of
 * the total input tokens. Below this, we can't confidently point at one culprit
 * and fall back to generic guidance.
 */
const DOMINANT_SOURCE_THRESHOLD = 0.5;

/**
 * Actionable remediation per dominant source. The overflow error previously
 * stated only the sizes, so the user was blocked with no idea what to do.
 * These hints tell them how to get unblocked.
 */
const SOURCE_REMEDIATION: Partial<Record<TokenSource, string>> = {
  fabFiles:
    'Most of your context is attached Fab Files. Remove or detach some files, attach smaller excerpts, or split this into multiple quests, then try again.',
  conversationHistory:
    'Most of your context is conversation history. Start a new session to reset the history, or summarize the discussion so far, then try again.',
  urlContent: 'Most of your context comes from fetched URLs. Reference fewer or shorter pages, then try again.',
  mementos: 'Most of your context comes from saved memories. Reduce how many mementos are in play, then try again.',
};

const GENERIC_REMEDIATION =
  'Reduce the size of your request — remove attachments, trim conversation history, or start a new session — then try again.';

function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, c => c.toUpperCase())
    .trim();
}

/**
 * Build the user-facing context-overflow message: a size summary, a token
 * breakdown sorted largest-first, and an actionable remediation hint chosen
 * from the dominant token source.
 */
export function buildContextOverflowMessage(params: ContextOverflowMessageParams): string {
  const { modelName, inputTokens, maxSafeInputTokens, tokensBySource, messageCount = 0, mementoCount = 0 } = params;

  const breakdownEntries = tokensBySource
    ? (Object.entries(tokensBySource) as Array<[TokenSource, number]>)
        .filter(([, tokens]) => typeof tokens === 'number' && tokens > 0)
        .sort(([, a], [, b]) => b - a)
    : [];

  const breakdownText =
    breakdownEntries.length > 0
      ? breakdownEntries.map(([key, tokens]) => `• ${formatLabel(key)}: ~${tokens.toLocaleString()} tokens`).join('\n')
      : `• ${messageCount} messages, ${mementoCount} mementos (detailed breakdown unavailable)`;

  let remediation = GENERIC_REMEDIATION;
  if (breakdownEntries.length > 0 && inputTokens > 0) {
    const [topKey, topTokens] = breakdownEntries[0];
    if (topTokens / inputTokens >= DOMINANT_SOURCE_THRESHOLD && SOURCE_REMEDIATION[topKey]) {
      remediation = SOURCE_REMEDIATION[topKey]!;
    }
  }

  return (
    `Your request is too large for ${modelName} ` +
    `(${inputTokens.toLocaleString()} tokens used, ${maxSafeInputTokens.toLocaleString()} max).\n\n` +
    `Token breakdown:\n${breakdownText}\n\n` +
    `💡 ${remediation}`
  );
}
