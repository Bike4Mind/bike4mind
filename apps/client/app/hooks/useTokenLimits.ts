import { useMemo } from 'react';

interface ModelInfoEntry {
  id: string;
  contextWindow?: number;
  max_tokens?: number;
}

interface UseTokenLimitsParams {
  model: string;
  modelInfo: ModelInfoEntry[] | undefined;
  max_tokens: number | undefined;
  chatInputLength: number;
}

// Minimum tokens to reserve for input when the defensive cap kicks in. Picked to be
// roughly a short paragraph - enough that the counter never reads `n/0` and the user
// can keep typing. For tiny context windows we fall back to ctx/2 instead.
const INPUT_HEADROOM_TOKENS = 1024;

export function useTokenLimits({ model, modelInfo, max_tokens, chatInputLength }: UseTokenLimitsParams) {
  const safeMaxTokens = max_tokens ?? 2048;

  const activeModelEntry = useMemo(() => modelInfo?.find(m => m.id === model), [model, modelInfo]);
  const contextWindowLimit = activeModelEntry?.contextWindow ?? 0;
  const modelCatalogMaxOutput = activeModelEntry?.max_tokens ?? 0;

  const getDefaultMaxOutputTokens = useMemo(() => {
    return Math.min(modelCatalogMaxOutput, 16384);
  }, [modelCatalogMaxOutput]);

  const effectiveMaxOutputTokens = useMemo(() => {
    const requested = max_tokens !== undefined && max_tokens > 0 ? max_tokens : getDefaultMaxOutputTokens;
    // Defensive cap against stale max_tokens persisted from a previously-selected model:
    // (1) cannot exceed this model's catalog max_tokens, (2) cannot consume the full
    // context window (which would leave 0 budget for input and trip the over-limit state).
    const cappedByModel = modelCatalogMaxOutput > 0 ? Math.min(requested, modelCatalogMaxOutput) : requested;
    if (contextWindowLimit > 0 && cappedByModel >= contextWindowLimit) {
      // For ctx < 2 * INPUT_HEADROOM_TOKENS, the absolute reserve would zero output -
      // fall back to halving the context so both sides stay positive.
      const reserve =
        contextWindowLimit >= INPUT_HEADROOM_TOKENS * 2 ? INPUT_HEADROOM_TOKENS : Math.floor(contextWindowLimit / 2);
      return Math.max(1, contextWindowLimit - reserve);
    }
    return cappedByModel;
  }, [max_tokens, getDefaultMaxOutputTokens, modelCatalogMaxOutput, contextWindowLimit]);

  const maxInputTokens = useMemo(() => {
    return Math.max(0, contextWindowLimit - effectiveMaxOutputTokens);
  }, [contextWindowLimit, effectiveMaxOutputTokens]);

  // Suppress the over-limit signal until modelInfo has loaded (contextWindowLimit > 0).
  // Otherwise a transient 0 makes any input look over-limit while the model catalog is in flight.
  const isOverContextWindow = useMemo(
    () => contextWindowLimit > 0 && chatInputLength > maxInputTokens,
    [chatInputLength, maxInputTokens, contextWindowLimit]
  );

  return {
    safeMaxTokens,
    contextWindowLimit,
    effectiveMaxOutputTokens,
    maxInputTokens,
    isOverContextWindow,
  };
}
