import {
  ABSTENTION_PROMPT,
  ARTIFACT_EMISSION_PROMPT,
  ChatModels,
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

// The costly end of the range: mid-tier (Sonnet-class) models, most preferred first.
export const PREMIUM_REFERENCE_MODEL_IDS: readonly string[] = [
  ChatModels.CLAUDE_5_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_5_SONNET_BEDROCK,
  ChatModels.CLAUDE_5_SONNET,
];

// The cheap end of the range: everyday small models, most preferred first.
export const BUDGET_REFERENCE_MODEL_IDS: readonly string[] = [
  ChatModels.GPT5_4_MINI,
  ChatModels.CLAUDE_5_5_HAIKU_BEDROCK,
  ChatModels.CLAUDE_5_5_HAIKU,
];

export interface ModelAnswerCost {
  modelName: string;
  creditsPerAnswer: number;
}

/** The two ends an estimate is quoted between; either may be missing from a given catalog. */
export interface AnswerCostReference {
  premium: ModelAnswerCost | null;
  budget: ModelAnswerCost | null;
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

function pickModelAnswerCost(models: readonly ModelInfo[], ids: readonly string[]): ModelAnswerCost | null {
  for (const id of ids) {
    const model = models.find(m => m.id === id && !m.disabled);
    const creditsPerAnswer = model ? typicalAnswerCredits(model) : null;
    if (model && creditsPerAnswer) return { modelName: model.name, creditsPerAnswer };
  }
  return null;
}

/** The premium and budget models the estimate is quoted between; null when neither is priced. */
export function pickAnswerCostReference(models: readonly ModelInfo[]): AnswerCostReference | null {
  const premium = pickModelAnswerCost(models, PREMIUM_REFERENCE_MODEL_IDS);
  const budget = pickModelAnswerCost(models, BUDGET_REFERENCE_MODEL_IDS);
  return premium || budget ? { premium, budget } : null;
}

/** Answers `credits` buys, rounded DOWN to two significant figures so the estimate never oversells. */
export function estimateAnswerCount(credits: number, creditsPerAnswer: number): number {
  const raw = Math.floor(credits / creditsPerAnswer);
  if (raw < 100) return raw;
  const step = 10 ** (Math.floor(Math.log10(raw)) - 1);
  return Math.floor(raw / step) * step;
}

const formatCount = (n: number) => n.toLocaleString('en-US');

/** One-sentence estimate for a credit amount, or null when there is nothing honest to say. */
export function formatAnswersEstimate(credits: number, reference: AnswerCostReference | null): string | null {
  if (!reference || !(credits > 0)) return null;
  const ends = [reference.premium, reference.budget]
    .filter((end): end is ModelAnswerCost => end !== null)
    .map(end => ({ ...end, answers: estimateAnswerCount(credits, end.creditsPerAnswer) }))
    .filter(end => end.answers >= 1)
    .sort((a, b) => a.answers - b.answers);
  if (ends.length === 0) return null;

  const low = ends[0];
  const high = ends[ends.length - 1];
  const answers =
    low.answers === high.answers
      ? `about ${formatCount(low.answers)} ${low.answers === 1 ? 'answer' : 'answers'} on ${low.modelName}`
      : `about ${formatCount(low.answers)} to ${formatCount(high.answers)} answers, depending on the model ` +
        `(${low.modelName} to ${high.modelName})`;
  const inputTokens = Math.round(TYPICAL_ANSWER_INPUT_TOKENS / 100) * 100;
  return (
    `Estimate: ${answers}, at about ${formatCount(inputTokens)} tokens in, including the app's instructions, ` +
    `and ${formatCount(TYPICAL_ANSWER_OUTPUT_TOKENS)} out per answer. ` +
    'Long chats, files, images and larger models use more.'
  );
}
