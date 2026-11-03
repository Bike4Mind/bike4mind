import {
  ADAPTIVE_THINKING_MAX_TOKENS_FLOOR,
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  FIXED_TEMPERATURE_MODELS,
  isClaudeModelId,
  MAX_THINKING_BUDGET_TOKENS,
  NO_TEMPERATURE_MODELS,
  type ReasoningEffort,
} from '@bike4mind/common';
import type { OpenAICompatibleProduct } from '@bike4mind/local-models';
import { REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from '@shared/chat';
import type { ModelControls, NumericControl } from '@shared/generation';

type Range = Pick<NumericControl, 'min' | 'max' | 'step'>;

const TEMPERATURE: Range = { min: 0, max: 2, step: 0.05 };
const TOP_P: Range = { min: 0, max: 1, step: 0.01 };
const TOP_K: Range = { min: 1, max: 200, step: 1 };
const MIN_P: Range = { min: 0, max: 1, step: 0.01 };
const REPEAT_PENALTY: Range = { min: 0.5, max: 2, step: 0.01 };
const MIN_OUTPUT_TOKENS = 256;
const OUTPUT_STEP = 256;
/** The hosted API's own floor for a legacy thinking budget, and its default when none is sent. */
const MIN_THINKING_BUDGET_TOKENS = 1024;
const DEFAULT_THINKING_BUDGET_TOKENS = 16_000;
/** For a hosted model with no stated output cap; the server clamps to the real one. */
const MIN_HOSTED_OUTPUT_TOKENS = 1024;

function control(range: Range, value?: number): NumericControl {
  return { ...range, ...(value !== undefined ? { default: value } : {}), scope: 'request' };
}

function outputControl(min: number, max: number, value?: number): NumericControl | undefined {
  if (!Number.isFinite(max) || max <= min) return undefined;
  return control({ min, max, step: OUTPUT_STEP }, value);
}

/** The levels in `values` that name a setting, lowest first. */
function effortLevels(values: readonly unknown[]): ReasoningEffortSetting[] {
  return REASONING_EFFORT_SETTINGS.filter(setting => setting !== 'default' && values.includes(setting));
}

/** One PARAMETER line from `/api/show`'s `parameters`, when it holds a finite number. */
export function modelfileParameter(parameters: string | undefined, name: string): number | undefined {
  const match = new RegExp(`^${name}[ \\t]+(\\S+)[ \\t]*$`, 'm').exec(parameters ?? '');
  const value = Number(match?.[1]);
  return match && Number.isFinite(value) ? value : undefined;
}

/** What Ollama applies when neither the request nor the Modelfile sets a value (api.DefaultOptions). */
const OLLAMA_DEFAULTS = { temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0, repeat_penalty: 1.1 } as const;

export interface OllamaModelFacts {
  /** False while `/api/show` has not answered: the ranges are known, the model's defaults are not. */
  inspected: boolean;
  parameters?: string;
  /** `/api/show`'s `thinking.values`: booleans, or effort names for a model such as gpt-oss. */
  thinkingValues?: readonly unknown[];
  /** The num_ctx Desktop runs the model with, which bounds a reply. */
  contextWindow: number;
}

/** Ollama takes every sampling option and num_predict per request, and `think` levels where the template has them. */
export function ollamaControls(facts: OllamaModelFacts): ModelControls {
  const known = (name: keyof typeof OLLAMA_DEFAULTS) =>
    facts.inspected ? (modelfileParameter(facts.parameters, name) ?? OLLAMA_DEFAULTS[name]) : undefined;
  const numPredict = facts.inspected ? modelfileParameter(facts.parameters, 'num_predict') : undefined;
  const levels = effortLevels(facts.thinkingValues ?? []);
  const maxOutputTokens = outputControl(
    MIN_OUTPUT_TOKENS,
    facts.contextWindow,
    numPredict !== undefined && numPredict > 0 ? numPredict : undefined
  );
  return {
    temperature: control(TEMPERATURE, known('temperature')),
    topP: control(TOP_P, known('top_p')),
    topK: control(TOP_K, known('top_k')),
    minP: control(MIN_P, known('min_p')),
    repeatPenalty: control(REPEAT_PENALTY, known('repeat_penalty')),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(levels.length > 0 ? { effort: { levels, scope: 'request' } } : {}),
  };
}

/** Effort levels an OpenAI-compatible server's `reasoning_effort` takes for the gpt-oss templates. */
export const OPENAI_COMPATIBLE_EFFORT_LEVELS: readonly ReasoningEffortSetting[] = ['low', 'medium', 'high'];

/**
 * The OpenAI fields every server takes, plus the extra body fields each product documents. An
 * unknown product gets only the OpenAI ones. Defaults live on the server, so none are stated.
 */
export function openAICompatibleControls(
  product: OpenAICompatibleProduct | null,
  facts: { contextWindow?: number; effortLevels: boolean }
): ModelControls {
  // vLLM refuses a request whose prompt plus max_tokens passes the context, so a reply may take half.
  const outputCeiling = facts.contextWindow !== undefined ? Math.floor(facts.contextWindow / 2) : 32_768;
  const maxOutputTokens = outputControl(MIN_OUTPUT_TOKENS, outputCeiling);
  return {
    temperature: control(TEMPERATURE),
    topP: control(TOP_P),
    ...(product !== null ? { topK: control(TOP_K), repeatPenalty: control(REPEAT_PENALTY) } : {}),
    ...(product === 'llama-server' || product === 'vllm' ? { minP: control(MIN_P) } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(facts.effortLevels ? { effort: { levels: [...OPENAI_COMPATIBLE_EFFORT_LEVELS], scope: 'request' } } : {}),
  };
}

/** What Desktop reads off a hosted catalog row to decide its controls. */
export interface HostedModelFacts {
  id: string;
  backend?: string;
  canThink: boolean;
  thinkingStyle?: string;
  maxOutputTokens?: number;
  /** The catalog sends OpenAI's `max_completion_tokens`, which the server pairs with a fixed temperature. */
  maxCompletionTokens?: boolean;
}

/** The levels Desktop offered before the server published its own, for a server that does not. */
const FALLBACK_HOSTED_EFFORTS: readonly ReasoningEffortSetting[] = ['minimal', 'low', 'medium', 'high'];

function servedAsClaude(model: HostedModelFacts): boolean {
  return (model.backend === 'anthropic' || model.backend === 'bedrock') && isClaudeModelId(model.id);
}

function thinksAdaptively(model: HostedModelFacts): boolean {
  return ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS.has(model.id) || model.thinkingStyle === 'adaptive';
}

/**
 * Temperature as the completions server treats it (llm-adapters): dropped for the models that reject
 * it and for Gemini and DeepSeek while they think, pinned at 1 for OpenAI's reasoning models and for
 * Claude while it thinks with a budget. Desktop asks every hosted Claude to think.
 */
function hostedTemperature(model: HostedModelFacts): NumericControl | undefined {
  if (NO_TEMPERATURE_MODELS.has(model.id)) return undefined;
  const claude = servedAsClaude(model);
  if (claude && thinksAdaptively(model)) return undefined;
  if (model.canThink && (model.backend === 'gemini' || model.backend === 'deepseek')) return undefined;
  const range: Range = claude ? { min: 0, max: 1, step: 0.05 } : TEMPERATURE;
  if (FIXED_TEMPERATURE_MODELS.has(model.id) || (model.maxCompletionTokens && model.canThink)) {
    return { ...control(range), locked: { value: 1, reason: 'This model only runs at temperature 1.' } };
  }
  if (claude && model.canThink) {
    return { ...control(range), locked: { value: 1, reason: 'Claude runs at temperature 1 while it thinks.' } };
  }
  return control(range);
}

/**
 * Controls for a hosted model, from its catalog row and the effort levels the server publishes
 * for it (`reasoning_efforts` on GET /api/v1/models). `efforts` undefined means the server did
 * not say, and the levels Desktop always offered stand in for a model in `effortFallback`.
 */
export function hostedControls(
  model: HostedModelFacts,
  efforts: readonly ReasoningEffort[] | undefined,
  effortFallback: boolean
): ModelControls {
  const claude = servedAsClaude(model);
  const budgeted = claude && model.canThink && !thinksAdaptively(model);
  // A Claude that thinks with a budget takes thinking.budget_tokens; Desktop's thinking request makes it ignore an effort.
  const levels = budgeted
    ? []
    : efforts
      ? REASONING_EFFORT_SETTINGS.filter(setting => setting !== 'default' && efforts.includes(setting))
      : effortFallback
        ? [...FALLBACK_HOSTED_EFFORTS]
        : [];
  const temperature = hostedTemperature(model);
  // The server raises an adaptive Claude's max_tokens to this floor while it thinks, so less is never sent.
  const outputFloor =
    claude && model.canThink && thinksAdaptively(model) ? ADAPTIVE_THINKING_MAX_TOKENS_FLOOR : MIN_HOSTED_OUTPUT_TOKENS;
  const cap = model.maxOutputTokens;
  const maxOutputTokens = cap ? outputControl(Math.min(outputFloor, cap), cap, cap) : undefined;
  return {
    ...(temperature ? { temperature } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(budgeted
      ? {
          thinkingBudgetTokens: control(
            { min: MIN_THINKING_BUDGET_TOKENS, max: MAX_THINKING_BUDGET_TOKENS, step: 1024 },
            DEFAULT_THINKING_BUDGET_TOKENS
          ),
        }
      : {}),
    ...(levels.length > 0 ? { effort: { levels, scope: 'request' } } : {}),
  };
}
