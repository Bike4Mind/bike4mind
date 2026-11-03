import { CREDITS_PER_USD_COST, getTextModelCost, type IMessage, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';

/**
 * The shortest answer worth calling a model for. A round that cannot afford this many output
 * tokens is refused (or, mid tool loop, not started) instead of sent with a uselessly small budget.
 */
export const MIN_AFFORDABLE_OUTPUT_TOKENS = 256;

export type RoundBudget = { affordable: true; outputTokens: number } | { affordable: false; minimumCredits: number };

/**
 * The largest output budget `availableCredits` can pay for once this round's input is priced, so
 * that input plus a full-length answer never costs more than the holder has. Credits are compared
 * before rounding, and settlement rounds stochastically (never above the ceiling of the exact
 * cost), so a round that stays inside this budget settles at or below `availableCredits`.
 *
 * `inputUsd` is the caller's conservative price of the round's input (cache reads and writes
 * included); `inputTokens` is the tier basis, since a long prompt moves output onto a dearer tier.
 */
export function affordableRoundBudget(params: {
  modelInfo: ModelInfo;
  inputUsd: number;
  inputTokens: number;
  availableCredits: number;
  minimumOutputTokens: number;
}): RoundBudget {
  const { modelInfo, inputUsd, inputTokens, availableCredits, minimumOutputTokens } = params;
  const inputCredits = inputUsd * CREDITS_PER_USD_COST;
  const perTokenCredits = getTextModelCost(modelInfo, 0, 1, 0, 0, inputTokens) * CREDITS_PER_USD_COST;
  const minimumCredits = Math.ceil(inputCredits + minimumOutputTokens * perTokenCredits);

  // An unpriced model costs nothing to answer, so only the input side can bind.
  if (!(perTokenCredits > 0)) {
    return inputCredits <= availableCredits
      ? { affordable: true, outputTokens: Number.MAX_SAFE_INTEGER }
      : { affordable: false, minimumCredits };
  }

  // The epsilon keeps float noise from flooring an exactly-affordable budget one token short.
  const outputTokens = Math.floor((availableCredits - inputCredits) / perTokenCredits + 1e-9);
  if (!Number.isFinite(outputTokens) || outputTokens < minimumOutputTokens) {
    return { affordable: false, minimumCredits };
  }
  return { affordable: true, outputTokens };
}

/**
 * Lowers a round's output budget to what it can pay for. `outputTokenCeiling` is the binding part:
 * adapters raise maxTokens on their own (the adaptive-thinking floor, Gemini's thinking reserve) and
 * clamp the result to the ceiling, so it is set to the full affordable figure, not min'd with maxTokens.
 */
export function capRoundOutput(
  options: Partial<ICompletionOptions>,
  affordableOutputTokens: number
): Partial<ICompletionOptions> {
  return {
    ...options,
    maxTokens: Math.min(options.maxTokens ?? affordableOutputTokens, affordableOutputTokens),
    outputTokenCeiling: affordableOutputTokens,
  };
}

/**
 * Before each provider round, returns the options to run it with, or null to end the turn there.
 * `round` is 0 for the call the caller makes and counts the adapter's tool-loop rounds after it.
 */
export type RoundGate = (
  messages: IMessage[],
  options: Partial<ICompletionOptions>,
  round: number
) => Promise<Partial<ICompletionOptions> | null>;

/**
 * Wraps `backend` so `gate` runs before every provider round, including the tool rounds a
 * server-executed completion runs inside the adapter. Relies on every adapter recursing into its
 * next round through `this.complete(...)` (anthropic, bedrock, openai, gemini, xai, deepseek, kimi,
 * ollama all do): the wrapper's prototype is the backend, so `this` is the wrapper and each
 * recursion re-enters the gate. A gate returning null ends the turn without calling the model;
 * the round that recursed simply returns. Adapters report earlier rounds' usage only on the
 * terminal round (it travels in `options._internal.accum*` until then), so a gate that prices or
 * stops a turn must read it from the options it is handed.
 */
export function gateEveryRound(backend: ICompletionBackend, gate: RoundGate): ICompletionBackend {
  const complete = backend.complete;
  let round = 0;
  const gated: ICompletionBackend = Object.create(backend);
  gated.complete = async function (this: ICompletionBackend, model, messages, options, callback) {
    const gatedOptions = await gate(messages, options, round++);
    if (gatedOptions === null) return;
    return complete.call(this, model, messages, gatedOptions, callback);
  };
  return gated;
}
