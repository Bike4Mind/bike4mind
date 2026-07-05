import { ModelInfo } from '@bike4mind/common';

export const calculateModelCost = (model: ModelInfo): { inputCost: number; outputCost: number } => {
  if (!model.pricing || Object.keys(model.pricing).length === 0) {
    return { inputCost: 0, outputCost: 0 };
  }

  // gpt-4o-mini has very small costs that need special handling
  if (model.id === 'gpt-4o-mini') {
    // Hardcoded from OpenAI pricing:
    // $0.15/1M input tokens -> 0.15 credits per 1K tokens
    // $0.60/1M output tokens -> 0.6 credits per 1K tokens
    return {
      inputCost: 0.15,
      outputCost: 0.6,
    };
  }

  // Use the first pricing tier
  const firstKey = Number(Object.keys(model.pricing)[0]);
  if (isNaN(firstKey) || !model.pricing[firstKey]) {
    return { inputCost: 0, outputCost: 0 };
  }

  if (model.type === 'image') {
    // Image models: pricing stored in dollars, converted to credits (1 USD ~= 1000 credits), floored at 0.1
    const inputCredits = Math.max(0.1, parseFloat((model.pricing[firstKey].input * 1000).toFixed(2)));
    const outputCredits = Math.max(0.1, parseFloat((model.pricing[firstKey].output * 1000).toFixed(2)));
    return { inputCost: inputCredits, outputCost: outputCredits };
  } else {
    // Text models: prices are dollars per token. *1000 for per-1K tokens, *1000 again to convert USD to credits (1 USD ~= 1000 credits)
    const rawInputCredits = model.pricing[firstKey].input * 1000 * 1000;
    const rawOutputCredits = model.pricing[firstKey].output * 1000 * 1000;

    // Floor at 0.1 credits for very small values
    const inputCredits = Math.max(
      0.1,
      rawInputCredits < 1 ? parseFloat(rawInputCredits.toFixed(2)) : Math.round(rawInputCredits)
    );

    const outputCredits = Math.max(
      0.1,
      rawOutputCredits < 1 ? parseFloat(rawOutputCredits.toFixed(2)) : Math.round(rawOutputCredits)
    );

    return { inputCost: inputCredits, outputCost: outputCredits };
  }
};
