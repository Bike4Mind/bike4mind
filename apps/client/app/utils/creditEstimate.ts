import {
  ABSTENTION_PROMPT,
  ARTIFACT_EMISSION_PROMPT,
  getTextModelCreditsPer1M,
  HELP_CENTER_PROMPT,
  REPLY_CHOICES_GUIDANCE,
  tokenEstimateMultiplier,
  type ModelInfo,
} from '@bike4mind/common';

// ~4.3 chars per cl100k token measured on the blocks below; 4 rounds the overhead up, never down.
const CHARS_PER_TOKEN = 4;

/**
 * The system prompt every in-app chat turn carries before the user types a word, sized from the
 * same defaults the server sends (see the taggedContextMessages assembly in ChatCompletionProcess).
 * Must stay in sync with that always-on floor; a new always-on block belongs here too.
 */
export const APP_PROMPT_TOKENS = Math.ceil(
  [ARTIFACT_EMISSION_PROMPT, HELP_CENTER_PROMPT, ABSTENTION_PROMPT, REPLY_CHOICES_GUIDANCE].join('\n\n').length /
    CHARS_PER_TOKEN
);

/**
 * The "typical answer" every credit estimate is priced at: a short prompt and a little history on
 * top of the app's own system prompt, roughly 750 words out. Counted in cl100k tokens and scaled to
 * each model's tokenizer, so a model that counts the same text as more tokens is billed for more.
 */
export const TYPICAL_PROMPT_TOKENS = 1_000;
export const TYPICAL_ANSWER_INPUT_TOKENS = APP_PROMPT_TOKENS + TYPICAL_PROMPT_TOKENS;
export const TYPICAL_ANSWER_OUTPUT_TOKENS = 1_000;

export interface ModelAnswerCost {
  modelName: string;
  creditsPerAnswer: number;
}

/** Credits a typical answer costs on `model`, at the rates billing charges; null when unpriced or free. */
export function typicalAnswerCredits(model: ModelInfo): number | null {
  const rates = getTextModelCreditsPer1M(model);
  if (!rates) return null;
  const multiplier = tokenEstimateMultiplier(model.id);
  const credits =
    (TYPICAL_ANSWER_INPUT_TOKENS * multiplier * rates.input +
      TYPICAL_ANSWER_OUTPUT_TOKENS * multiplier * rates.output) /
    1_000_000;
  return credits > 0 ? credits : null;
}

/** What a typical answer costs on `model`; null when the model is unpriced or free to run. */
export function modelAnswerCost(model: ModelInfo): ModelAnswerCost | null {
  const creditsPerAnswer = typicalAnswerCredits(model);
  return creditsPerAnswer ? { modelName: model.name, creditsPerAnswer } : null;
}

/** Answers `credits` buys, rounded DOWN to two significant figures so the estimate never oversells. */
export function estimateAnswerCount(credits: number, creditsPerAnswer: number): number {
  const raw = Math.floor(credits / creditsPerAnswer);
  if (raw < 100) return raw;
  const step = 10 ** (Math.floor(Math.log10(raw)) - 1);
  return Math.floor(raw / step) * step;
}

const formatCount = (n: number) => n.toLocaleString('en-US');

/** One-sentence estimate for a credit amount on one model, or null when there is nothing honest to say. */
export function formatAnswersEstimate(credits: number, cost: ModelAnswerCost | null): string | null {
  if (!cost || !(credits > 0)) return null;
  const answers = estimateAnswerCount(credits, cost.creditsPerAnswer);
  if (answers < 1) return null;
  return (
    `Estimate: about ${formatCount(answers)} ${answers === 1 ? 'answer' : 'answers'} on ${cost.modelName}. ` +
    'Long chats, files, images and larger models use more.'
  );
}
