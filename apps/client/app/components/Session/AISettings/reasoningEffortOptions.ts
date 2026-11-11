import {
  isClaudeModelId,
  OPENAI_XHIGH_REASONING_EFFORT_MODELS,
  REASONING_SUPPORTED_MODELS,
  type ModelInfo,
  type ReasoningEffort,
  type UserReasoningEffort,
} from '@bike4mind/common';
import { chatReasoningEffortsFor } from '@bike4mind/llm-adapters/model-sizing';

export interface ReasoningEffortOption {
  value: UserReasoningEffort;
  label: string;
}

const AUTO_OPTION: ReasoningEffortOption = { value: 'auto', label: 'Auto' };

const BASE_REASONING_EFFORT_OPTIONS: ReasoningEffortOption[] = [
  AUTO_OPTION,
  { value: 'low', label: 'Low (Fast)' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High (Best)' },
];

const XHIGH_OPTION: ReasoningEffortOption = { value: 'xhigh', label: 'Extra High (Best)' };

const CLAUDE_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low (Fast)',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High (Best)',
};

/**
 * What the Reasoning Effort dropdown offers for `model`; empty hides it. OpenAI keeps its fixed list,
 * with Extra High only on OPENAI_XHIGH_REASONING_EFFORT_MODELS, the same set the server clamps to.
 * Claude lists the levels chat actually sends it (chatReasoningEffortsFor, which the server's
 * chatReasoningEffortFor clamps to), so a legacy or non-thinking Claude model shows no dropdown.
 */
export function reasoningEffortOptionsFor(
  model: string,
  modelInfo: ModelInfo | null | undefined
): ReasoningEffortOption[] {
  if (REASONING_SUPPORTED_MODELS.has(model)) {
    if (!OPENAI_XHIGH_REASONING_EFFORT_MODELS.has(model)) return BASE_REASONING_EFFORT_OPTIONS;
    return [
      ...BASE_REASONING_EFFORT_OPTIONS.map(o => (o.value === 'high' ? { ...o, label: 'High' } : o)),
      XHIGH_OPTION,
    ];
  }
  if (!modelInfo || modelInfo.id !== model || !isClaudeModelId(model)) return [];
  const levels = chatReasoningEffortsFor(modelInfo);
  if (levels.length === 0) return [];
  return [AUTO_OPTION, ...levels.map(level => ({ value: level, label: CLAUDE_EFFORT_LABELS[level] }))];
}
