/**
 * Remembers that a user declined the "switch off this stale model" prompt.
 *
 * Scoped to session + model, not to the model alone: the pin is per-notebook, so a
 * deliberate hold on an old model in one notebook says nothing about the others.
 * Losing these on a localStorage failure only means the prompt reappears, so every
 * access degrades to "not dismissed" rather than throwing.
 */
export const STALE_MODEL_PROMPT_DISMISSED_KEY = 'b4m:staleModelPrompt:dismissed';

// Bounded so a heavy user with hundreds of notebooks can't grow this without limit.
// Oldest entries fall off first; the worst case is one extra prompt in a notebook
// untouched for a very long time.
const MAX_DISMISSALS = 200;

const entryKey = (sessionId: string, modelId: string) => `${sessionId}::${modelId}`;

function read(): string[] {
  try {
    const raw = localStorage.getItem(STALE_MODEL_PROMPT_DISMISSED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function isStaleModelPromptDismissed(sessionId: string, modelId: string): boolean {
  return read().includes(entryKey(sessionId, modelId));
}

export function dismissStaleModelPrompt(sessionId: string, modelId: string): void {
  const key = entryKey(sessionId, modelId);
  const next = [...read().filter(k => k !== key), key].slice(-MAX_DISMISSALS);
  try {
    localStorage.setItem(STALE_MODEL_PROMPT_DISMISSED_KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable - the prompt simply shows again next time.
  }
}
