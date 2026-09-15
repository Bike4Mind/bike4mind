/**
 * Substrings of known provider context-window errors, matched case-insensitively.
 * Adapters do not currently classify context-limit errors with a dedicated
 * error type/code, so the raw provider message is the only signal: Anthropic
 * ("prompt is too long"), OpenAI ("maximum context length" /
 * "context_length_exceeded"), the Bedrock backend's synthetic overflow message
 * ("the conversation is too long ... context window"), plus generic phrasing
 * other providers use.
 */
const CONTEXT_LIMIT_PATTERNS = [
  'prompt is too long',
  'maximum context length',
  'context_length_exceeded',
  'context window',
  'context length',
  'maximum context',
  'input is too long',
  'the conversation is too long',
];

/** Depth cap on `cause` chain walking - guards against a circular/malicious cause graph. */
const MAX_CAUSE_DEPTH = 10;

/**
 * Collect every message string reachable from an error: its own `.message`,
 * a nested `.error.message` (the shape some SDKs wrap provider error bodies
 * in), and any `.cause` chain, so a context-limit substring buried in a
 * wrapped/retried error is still found.
 */
function collectMessages(error: unknown): string[] {
  if (typeof error === 'string') return [error];

  const messages: string[] = [];
  let current: unknown = error;
  let depth = 0;
  const seen = new Set<unknown>();

  while (current && typeof current === 'object' && !seen.has(current) && depth < MAX_CAUSE_DEPTH) {
    seen.add(current);
    depth++;

    const err = current as { message?: unknown; error?: { message?: unknown }; cause?: unknown };
    if (typeof err.message === 'string') messages.push(err.message);
    if (err.error && typeof err.error === 'object' && typeof err.error.message === 'string') {
      messages.push(err.error.message);
    }
    current = err.cause;
  }

  return messages;
}

/**
 * True when an error indicates the prompt/conversation exceeded the model's
 * context window, as opposed to auth, network, abort, or permission failures.
 * Used by `ReActAgent.run()` to decide whether a thrown completion error is
 * eligible for one-shot reactive compaction + retry (see `AgentRunOptions.onContextLimit`).
 */
export function isContextLimitError(error: unknown): boolean {
  const messages = collectMessages(error);
  return messages.some(message => {
    const lower = message.toLowerCase();
    return CONTEXT_LIMIT_PATTERNS.some(pattern => lower.includes(pattern));
  });
}
