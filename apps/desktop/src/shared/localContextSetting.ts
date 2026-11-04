/** The context sizes Settings offers for local models; Desktop's own instructions alone run past 8K. */
export const LOCAL_CONTEXT_SIZES = [16384, 32768, 65536, 131072, 262144] as const;
export type LocalContextSize = (typeof LOCAL_CONTEXT_SIZES)[number];

/** How local models size their context: from this computer's memory, or one size for every model. */
export type LocalContextSetting = { mode: 'auto' } | { mode: 'fixed'; tokens: LocalContextSize };

export const AUTO_LOCAL_CONTEXT: LocalContextSetting = { mode: 'auto' };

/** One model's own choice from the Models screen, in place of the Settings one: Auto up to a cap, or one size. */
export type ModelContextSetting = { mode: 'auto'; maxTokens?: number } | { mode: 'fixed'; tokens: number };

const MIN_MODEL_CONTEXT_TOKENS = 512;

// A model's trained length can fall between or below the offered sizes, so any whole number up to the top size is kept.
function isContextTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_MODEL_CONTEXT_TOKENS &&
    value <= LOCAL_CONTEXT_SIZES[LOCAL_CONTEXT_SIZES.length - 1]
  );
}

/** Null when `value` is not one; a cap or size outside 512 to the top offered size is not one either. */
export function parseModelContextSetting(value: unknown): ModelContextSetting | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { mode, tokens, maxTokens } = value as { mode?: unknown; tokens?: unknown; maxTokens?: unknown };
  if (mode === 'fixed') return isContextTokens(tokens) ? { mode, tokens } : null;
  if (mode !== 'auto') return null;
  if (maxTokens === undefined) return { mode };
  return isContextTokens(maxTokens) ? { mode, maxTokens } : null;
}

/** For each size, the local models the memory estimate says it would not fit. */
export type LocalContextFit = Partial<Record<LocalContextSize, string[]>>;

/** Anything unreadable is Auto, the default. */
export function parseLocalContextSetting(value: unknown): LocalContextSetting {
  if (!value || typeof value !== 'object') return AUTO_LOCAL_CONTEXT;
  const { mode, tokens } = value as { mode?: unknown; tokens?: unknown };
  if (mode === 'fixed' && LOCAL_CONTEXT_SIZES.includes(tokens as LocalContextSize))
    return { mode: 'fixed', tokens: tokens as LocalContextSize };
  return AUTO_LOCAL_CONTEXT;
}

export function contextSizeLabel(tokens: number): string {
  const k = tokens / 1024;
  return tokens >= 1024 && Number.isInteger(k * 10) ? `${k}K tokens` : `${tokens} tokens`;
}
