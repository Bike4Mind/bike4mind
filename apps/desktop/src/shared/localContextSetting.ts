import { LOCAL_CONTEXT_SIZES, type LocalContextSize } from '@bike4mind/local-models/model-settings';

export {
  LOCAL_CONTEXT_SIZES,
  parseModelContextSetting,
  type LocalContextSize,
  type ModelContextSetting,
} from '@bike4mind/local-models/model-settings';

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
  const k = tokens / 1024;
  return tokens >= 1024 && Number.isInteger(k * 10) ? `${k}K tokens` : `${tokens} tokens`;
}
