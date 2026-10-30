import {
  ABSTENTION_PROMPT,
  ARTIFACT_EMISSION_PROMPT,
  CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS,
  getTextModelCost,
  getTextModelCreditsPer1M,
  HELP_CENTER_PROMPT,
  isModelDeprecated,
  REPLY_CHOICES_GUIDANCE,
  reservationOutputTokens,
  tokenEstimateMultiplier,
  type ModelInfo,
  usdToCredits,
} from '@bike4mind/common';
import { sentMaxTokensFor, reasonsWithinOutputBudget } from '@bike4mind/llm-adapters/model-sizing';
import { computeDefaultMaxTokens } from './aiSettingsUtils';

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

/** Recent context in the selected model's token units plus a conservative draft estimate. */
export function estimateNextInputTokens(
  previousInputTokens: number | undefined,
  draft: string,
  selectedModelId?: string,
  previousModelId?: string
): number {
  const selectedMultiplier = tokenEstimateMultiplier(selectedModelId);
  const previousMultiplier = tokenEstimateMultiplier(previousModelId ?? selectedModelId);
  const previousTokens = ((previousInputTokens ?? 0) / previousMultiplier) * selectedMultiplier;
  return Math.ceil(Math.max(previousTokens, TYPICAL_ANSWER_INPUT_TOKENS * selectedMultiplier) + draft.length);
}

export interface ModelAnswerCost {
  modelName: string;
  creditsPerAnswer: number;
}

/** Credits a typical answer costs on `model`, at the rates billing charges; null when unpriced or free. */
export function typicalAnswerCredits(model: ModelInfo): number | null {
  if (model.freeToRun) return null;
  const rates = getTextModelCreditsPer1M(model);
  if (!rates) return null;
  const multiplier = tokenEstimateMultiplier(model.id);
  const credits =
    (TYPICAL_ANSWER_INPUT_TOKENS * multiplier * rates.input +
      TYPICAL_ANSWER_OUTPUT_TOKENS * multiplier * rates.output) /
    1_000_000;
  return credits > 0 ? credits : null;
}

type PreflightThinking = {
  enabled?: boolean;
  budget_tokens?: number;
};

/** Credits the chat admission hold needs for this model, context size and output ceiling. */
export function preflightAnswerCredits(
  model: ModelInfo,
  inputTokens: number,
  maxTokens: number,
  thinking?: PreflightThinking
): number | null {
  if (model.freeToRun) return 0;
  if (!model.pricing || Object.keys(model.pricing).length === 0) return null;
  const sentMaxTokens = sentMaxTokensFor(model, thinking, maxTokens);
  const outputTokens = reservationOutputTokens(
    sentMaxTokens,
    sentMaxTokens > maxTokens || reasonsWithinOutputBudget(model)
  );
  return usdToCredits(getTextModelCost(model, inputTokens, outputTokens));
}

export interface AffordableModelOffer {
  current: ModelAnswerCost;
  affordable: ModelInfo;
  affordableCredits: number;
}

/** Cheapest accessible text model whose estimated admission hold fits the balance. */
export function findAffordableModelOffer(
  models: readonly ModelInfo[],
  selectedModelId: string,
  credits: number,
  inputTokens: number,
  selectedMaxTokens: number,
  thinking?: PreflightThinking
): AffordableModelOffer | null {
  // The composer blocks a zero balance even on free models, so a switch cannot help there.
  if (!(credits > 0)) return null;
  const selected = models.find(model => model.id === selectedModelId);
  if (!selected || selected.type !== 'text') return null;
  const selectedCredits = preflightAnswerCredits(selected, inputTokens, selectedMaxTokens, thinking);
  if (selectedCredits === null || selectedCredits <= credits) return null;

  const affordable = models
    .filter(
      model => model.type === 'text' && model.id !== selectedModelId && !model.disabled && !isModelDeprecated(model)
    )
    .map(model => {
      // The current estimate uses the selected model's tokenizer; candidates may count it differently.
      const candidateInputTokens = Math.ceil(
        (inputTokens / tokenEstimateMultiplier(selected.id)) * tokenEstimateMultiplier(model.id)
      );
      const maxTokens = computeDefaultMaxTokens(model);
      const sentMaxTokens = sentMaxTokensFor(model, thinking, maxTokens);
      const fitsContext =
        candidateInputTokens + sentMaxTokens + CONTEXT_WINDOW_SAFETY_BUFFER_TOKENS <= model.contextWindow;
      return {
        model,
        credits: fitsContext ? preflightAnswerCredits(model, candidateInputTokens, maxTokens, thinking) : null,
      };
    })
    .filter((candidate): candidate is { model: ModelInfo; credits: number } => candidate.credits !== null)
    .filter(candidate => candidate.credits <= credits && candidate.credits < selectedCredits)
    .sort((a, b) => a.credits - b.credits)[0];

  if (!affordable) return null;
  return {
    current: { modelName: selected.name, creditsPerAnswer: selectedCredits },
    affordable: affordable.model,
    affordableCredits: affordable.credits,
  };
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
