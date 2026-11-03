import {
  ADAPTIVE_THINKING_MAX_TOKENS_FLOOR,
  ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS,
  FIXED_TEMPERATURE_MODELS,
  isClaudeModelId,
  MAX_THINKING_BUDGET_TOKENS,
  NO_TEMPERATURE_MODELS,
  REASONING_SUPPORTED_MODELS,
  stripBedrockRegionPrefix,
  type ReasoningEffort,
} from '@bike4mind/common';
import type { OpenAICompatibleProduct } from '@bike4mind/local-models';
import { REASONING_EFFORT_SETTINGS, type ReasoningEffortSetting } from '@shared/chat';
import type { ModelControls, NumericControl } from '@shared/generation';

type Range = Pick<NumericControl, 'min' | 'max' | 'step'>;

const TEMPERATURE: Range = { min: 0, max: 2, step: 0.05 };
/** Bedrock's model families take 0 to 1, Claude included. */
const UNIT_TEMPERATURE: Range = { min: 0, max: 1, step: 0.05 };
const TOP_P: Range = { min: 0, max: 1, step: 0.01 };
/** vLLM refuses a top_p of 0. */
const OPENAI_TOP_P: Range = { min: 0.01, max: 1, step: 0.01 };
/** 0 turns top_k off in llama.cpp, which Ollama and llama-server run. */
const LLAMA_CPP_TOP_K: Range = { min: 0, max: 200, step: 1 };
const TOP_K: Range = { min: 1, max: 200, step: 1 };
const MIN_P: Range = { min: 0, max: 1, step: 0.01 };
const REPEAT_PENALTY: Range = { min: 0.5, max: 2, step: 0.01 };
const PRESENCE_PENALTY: Range = { min: 0, max: 2, step: 0.05 };
const MIN_OUTPUT_TOKENS = 256;
const OUTPUT_STEP = 256;
/** The hosted API's own floor for a legacy thinking budget, and its default when none is sent. */
const MIN_THINKING_BUDGET_TOKENS = 1024;
const DEFAULT_THINKING_BUDGET_TOKENS = 16_000;
/** The answer room the server adds above a legacy budget (THINKING_ANSWER_HEADROOM_TOKENS in llm-adapters thinkingParams.ts). */
const THINKING_ANSWER_HEADROOM_TOKENS = 1000;
/** For a hosted model with no stated output cap; the server clamps to the real one. */
const MIN_HOSTED_OUTPUT_TOKENS = 1024;

function control(range: Range, value?: number): NumericControl {
  return { ...range, ...(value !== undefined ? { default: value } : {}), scope: 'request' };
}

function outputControl(min: number, max: number, value?: number, thinks = false): NumericControl | undefined {
  if (!Number.isFinite(max) || max <= min) return undefined;
  return { ...control({ min, max, step: OUTPUT_STEP }, value), ...(thinks ? { includesThinking: true } : {}) };
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
const OLLAMA_DEFAULTS = {
  temperature: 0.8,
  top_p: 0.9,
  top_k: 40,
  min_p: 0,
  repeat_penalty: 1.1,
  presence_penalty: 0,
} as const;

export interface OllamaModelFacts {
  /** False while `/api/show` has not answered: the ranges are known, the model's defaults are not. */
  inspected: boolean;
  parameters?: string;
  /** `/api/show`'s `thinking.values`: booleans, or effort names for a model such as gpt-oss. */
  thinkingValues?: readonly unknown[];
  /** The num_ctx Desktop runs the model with, which bounds a reply. */
  contextWindow: number;
  /** num_predict counts thinking as well as the answer. */
  thinks?: boolean;
}

/** Ollama takes every sampling option and num_predict per request, and `think` levels where the template has them. */
export function ollamaControls(facts: OllamaModelFacts): ModelControls {
  const known = (name: keyof typeof OLLAMA_DEFAULTS) =>
    facts.inspected ? (modelfileParameter(facts.parameters, name) ?? OLLAMA_DEFAULTS[name]) : undefined;
  const numPredict = facts.inspected ? modelfileParameter(facts.parameters, 'num_predict') : undefined;
  const levels = effortLevels(facts.thinkingValues ?? []);
  const limited = numPredict !== undefined && numPredict > 0;
  const output = outputControl(MIN_OUTPUT_TOKENS, facts.contextWindow, limited ? numPredict : undefined, facts.thinks);
  // Ollama's own num_predict default is -1, which a Modelfile can also set.
  const maxOutputTokens =
    output && facts.inspected && !limited ? { ...output, unlimitedDefault: true as const } : output;
  return {
    temperature: control(TEMPERATURE, known('temperature')),
    topP: control(TOP_P, known('top_p')),
    topK: control(LLAMA_CPP_TOP_K, known('top_k')),
    minP: control(MIN_P, known('min_p')),
    repeatPenalty: control(REPEAT_PENALTY, known('repeat_penalty')),
    presencePenalty: control(PRESENCE_PENALTY, known('presence_penalty')),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(levels.length > 0 ? { effort: { levels, scope: 'request' } } : {}),
  };
}

/** An Ollama model's controls once its context is settled, which bounds a reply as at listing. */
export function withOllamaContext(controls: ModelControls, contextWindow: number): ModelControls {
  const { maxOutputTokens: output, ...rest } = controls;
  if (!output) return controls;
  return contextWindow > output.min ? { ...rest, maxOutputTokens: { ...output, max: contextWindow } } : rest;
}

/** Effort levels an OpenAI-compatible server's `reasoning_effort` takes for the gpt-oss templates. */
export const OPENAI_COMPATIBLE_EFFORT_LEVELS: readonly ReasoningEffortSetting[] = ['low', 'medium', 'high'];

/**
 * The OpenAI fields every server takes, plus the extra body fields each product documents. An
 * unknown product gets only the OpenAI ones. Defaults live on the server, so none are stated.
 */
export function openAICompatibleControls(
  product: OpenAICompatibleProduct | null,
  facts: { contextWindow?: number; effortLevels: boolean; thinks?: boolean }
): ModelControls {
  // vLLM refuses a request whose prompt plus max_tokens passes the context, so a reply may take half.
  const outputCeiling = facts.contextWindow !== undefined ? Math.floor(facts.contextWindow / 2) : 32_768;
  const maxOutputTokens = outputControl(
    MIN_OUTPUT_TOKENS,
    outputCeiling,
    undefined,
    facts.effortLevels || facts.thinks === true
  );
  const topK = control(product === 'llama-server' ? LLAMA_CPP_TOP_K : TOP_K);
  return {
    temperature: control(TEMPERATURE),
    topP: control(OPENAI_TOP_P),
    presencePenalty: control(PRESENCE_PENALTY),
    ...(product !== null ? { topK, repeatPenalty: control(REPEAT_PENALTY) } : {}),
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
  /** `reasons_within_output_budget` on GET /api/v1/models; absent when the server did not say. */
  reasonsWithinOutputBudget?: boolean;
}

/** The levels Desktop offered before the server published its own, for a server that does not. */
const FALLBACK_HOSTED_EFFORTS: readonly ReasoningEffortSetting[] = ['minimal', 'low', 'medium', 'high'];

function servedAsClaude(model: HostedModelFacts): boolean {
  return (model.backend === 'anthropic' || model.backend === 'bedrock') && isClaudeModelId(model.id);
}

function thinksAdaptively(model: HostedModelFacts): boolean {
  return ANTHROPIC_OUTPUT_CONFIG_EFFORT_MODELS.has(model.id) || model.thinkingStyle === 'adaptive';
}

/** The server's answer, else the part of reasonsWithinOutputBudget (llm-adapters thinkingParams.ts) a client can decide. */
function reasonsWithinOutputBudget(model: HostedModelFacts): boolean {
  if (model.reasonsWithinOutputBudget !== undefined) return model.reasonsWithinOutputBudget;
  return (
    model.thinkingStyle === 'adaptive' ||
    REASONING_SUPPORTED_MODELS.has(model.id) ||
    (model.maxCompletionTokens === true && model.canThink)
  );
}

/**
 * Temperature as the completions server treats it (llm-adapters): dropped for the models that reject
 * it, for Gemini and DeepSeek while they think and by the Bedrock DeepSeek adapter, pinned at 1 for
 * OpenAI's reasoning models and for Claude while it thinks with a budget. Desktop asks every hosted
 * Claude to think.
 */
function hostedTemperature(model: HostedModelFacts): NumericControl | undefined {
  if (NO_TEMPERATURE_MODELS.has(model.id)) return undefined;
  const claude = servedAsClaude(model);
  if (claude && thinksAdaptively(model)) return undefined;
  if (model.canThink && (model.backend === 'gemini' || model.backend === 'deepseek')) return undefined;
  const bedrock = model.backend === 'bedrock';
  if (bedrock && stripBedrockRegionPrefix(model.id).startsWith('deepseek.')) return undefined;
  const range = claude || bedrock ? UNIT_TEMPERATURE : TEMPERATURE;
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
  const cap = model.maxOutputTokens;
  // The server raises max_tokens to the budget plus its headroom and never back to the cap, so a larger budget
  // fails the turn. With no cap stated, only lowering the budget the server sends by default is known to fit.
  const budgetMax = cap
    ? Math.min(MAX_THINKING_BUDGET_TOKENS, cap - THINKING_ANSWER_HEADROOM_TOKENS)
    : DEFAULT_THINKING_BUDGET_TOKENS;
  const budgetDefault = Math.min(DEFAULT_THINKING_BUDGET_TOKENS, budgetMax);
  const thinkingBudgetTokens =
    budgeted && budgetMax >= MIN_THINKING_BUDGET_TOKENS
      ? {
          ...control({ min: MIN_THINKING_BUDGET_TOKENS, max: budgetMax, step: 1024 }, budgetDefault),
          ...(budgetDefault < DEFAULT_THINKING_BUDGET_TOKENS ? { sendsDefault: true as const } : {}),
        }
      : undefined;
  // The server raises an adaptive Claude's max_tokens to this floor while it thinks, and gives any model that
  // reasons inside max_tokens the same when none is sent, since less can be spent on reasoning alone.
  const reasons = reasonsWithinOutputBudget(model) || (claude && model.canThink && thinksAdaptively(model));
  const outputFloor = reasons ? ADAPTIVE_THINKING_MAX_TOKENS_FLOOR : MIN_HOSTED_OUTPUT_TOKENS;
  const output = cap
    ? outputControl(Math.min(outputFloor, cap), cap, cap, reasons || thinkingBudgetTokens !== undefined)
    : undefined;
  const maxOutputTokens =
    output && thinkingBudgetTokens ? { ...output, budgetHeadroom: THINKING_ANSWER_HEADROOM_TOKENS } : output;
  return {
    ...(temperature ? { temperature } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(thinkingBudgetTokens ? { thinkingBudgetTokens } : {}),
    ...(levels.length > 0 ? { effort: { levels, scope: 'request' } } : {}),
  };
}
