/** The context sizes Settings offers for local models; Desktop's own instructions alone run past 8K. */
export const LOCAL_CONTEXT_SIZES = [16384, 32768, 65536, 131072, 262144] as const;
export type LocalContextSize = (typeof LOCAL_CONTEXT_SIZES)[number];

/** How local models size their context: from this computer's memory, or one size for every model. */
export type LocalContextSetting = { mode: 'auto' } | { mode: 'fixed'; tokens: LocalContextSize };

export const AUTO_LOCAL_CONTEXT: LocalContextSetting = { mode: 'auto' };

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
  return `${Math.round(tokens / 1024)}K tokens`;
}
