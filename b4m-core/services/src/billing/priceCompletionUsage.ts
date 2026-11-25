import {
  buildUsagePriceStamp,
  getTextModelCost,
  getTurnsCost,
  type IUsageEventInput,
  type ModelInfo,
  type TurnUsage,
} from '@bike4mind/common';

type CompletionUsageForPricing = Partial<TurnUsage> & { turnUsage?: readonly TurnUsage[] };

export function priceCompletionUsage(model: ModelInfo, usage: CompletionUsageForPricing) {
  const turns = usage.turnUsage?.some(
    turn => turn.inputTokens || turn.outputTokens || turn.cacheReadInputTokens || turn.cacheCreationInputTokens
  )
    ? usage.turnUsage
    : undefined;
  const zeroTokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const totals = turns?.reduce<typeof zeroTokens>(
    (total, turn) => ({
      inputTokens: total.inputTokens + turn.inputTokens,
      outputTokens: total.outputTokens + turn.outputTokens,
      cacheReadInputTokens: total.cacheReadInputTokens + (turn.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: total.cacheCreationInputTokens + (turn.cacheCreationInputTokens ?? 0),
    }),
    zeroTokens
  );
  const { inputTokens = 0, outputTokens = 0, cacheReadInputTokens = 0, cacheCreationInputTokens = 0 } = totals ?? usage;
  const promptTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens;
  const cacheWrite1hTokens = usage.cacheWrite1hInputTokens;

  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: cacheReadInputTokens,
    cacheWriteTokens: cacheCreationInputTokens,
    costUsd: turns
      ? getTurnsCost(model, turns)
      : getTextModelCost(
          model,
          inputTokens,
          outputTokens,
          cacheReadInputTokens,
          cacheCreationInputTokens,
          promptTokens,
          cacheWrite1hTokens
        ),
    priceStamp: buildUsagePriceStamp(model, { turns, tierBasisTokens: promptTokens, cacheWrite1hTokens }),
  };
}

export function timedOutCompletionUsageFields({
  inputTokens,
  outputTokens = 0,
}: {
  inputTokens: number;
  outputTokens?: number;
}): Pick<
  IUsageEventInput,
  'status' | 'settledBasis' | 'inputTokens' | 'outputTokens' | 'providerInputTokens' | 'providerOutputTokens'
> {
  return {
    status: 'timeout',
    settledBasis: 'provider',
    inputTokens: 0,
    outputTokens: 0,
    providerInputTokens: inputTokens,
    ...(outputTokens > 0 ? { providerOutputTokens: outputTokens } : {}),
  };
}
