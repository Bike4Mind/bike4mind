import { ChatModels, getTextModelCreditsPer1M, type ModelInfo } from '@bike4mind/common';

/**
 * The "typical answer" every credit estimate is priced at: a prompt plus the system prompt and a
 * little history in, roughly 750 words out. Stated next to the estimate so the user can judge it.
 */
export const TYPICAL_ANSWER_INPUT_TOKENS = 4_000;
export const TYPICAL_ANSWER_OUTPUT_TOKENS = 1_000;

// Mid-tier (Sonnet-class) reference models, most preferred first. The first one present, enabled and
// priced in the user's catalog is the one the estimate names.
export const ESTIMATE_REFERENCE_MODEL_IDS: readonly string[] = [
  ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_5_SONNET,
];

export interface AnswerCostReference {
  modelName: string;
  creditsPerAnswer: number;
}

/** Credits a typical answer costs on `model`, at the rates billing charges; null when unpriced or free. */
export function typicalAnswerCredits(model: ModelInfo): number | null {
  const rates = getTextModelCreditsPer1M(model);
  if (!rates) return null;
  const credits = (TYPICAL_ANSWER_INPUT_TOKENS * rates.input + TYPICAL_ANSWER_OUTPUT_TOKENS * rates.output) / 1_000_000;
  return credits > 0 ? credits : null;
}

/** The mid-tier model the estimate is quoted on, with its per-answer cost; null when none is priced. */
export function pickAnswerCostReference(models: readonly ModelInfo[]): AnswerCostReference | null {
  for (const id of ESTIMATE_REFERENCE_MODEL_IDS) {
    const model = models.find(m => m.id === id && !m.disabled);
    const creditsPerAnswer = model ? typicalAnswerCredits(model) : null;
    if (model && creditsPerAnswer) return { modelName: model.name, creditsPerAnswer };
  }
  return null;
}

/** Answers `credits` buys, rounded DOWN to two significant figures so the estimate never oversells. */
export function estimateAnswerCount(credits: number, creditsPerAnswer: number): number {
  const raw = Math.floor(credits / creditsPerAnswer);
  if (raw < 100) return raw;
  const step = 10 ** (Math.floor(Math.log10(raw)) - 1);
  return Math.floor(raw / step) * step;
}

/** One-sentence estimate for a credit amount, or null when there is nothing honest to say. */
export function formatAnswersEstimate(credits: number, reference: AnswerCostReference | null): string | null {
  if (!reference || !(credits > 0)) return null;
  const answers = estimateAnswerCount(credits, reference.creditsPerAnswer);
  if (answers < 1) return null;
  return (
    `Estimate: about ${answers.toLocaleString('en-US')} answers on ${reference.modelName}, ` +
    `at about ${TYPICAL_ANSWER_INPUT_TOKENS.toLocaleString('en-US')} tokens in and ` +
    `${TYPICAL_ANSWER_OUTPUT_TOKENS.toLocaleString('en-US')} out per answer. ` +
    'Long chats, files, images and larger models use more.'
  );
}
