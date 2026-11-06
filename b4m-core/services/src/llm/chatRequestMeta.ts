import type { IUsageEventRequestMeta } from '@bike4mind/common';

/** Longest stop reason / effort label kept; matches the UsageEventRequestMeta schema bounds. */
const STOP_REASON_MAX = 64;
const EFFORT_MAX = 32;
const TOOL_NAME_MAX = 128;

type ChatRequestMetaInput = {
  stopReason?: string | null;
  maxOutputTokens?: number;
  limiter?: { cappedOutputTokens?: number; stoppedForCredits: boolean } | null;
  reasoningEffort?: string;
  thinkingBudgetTokens?: number;
  functionCalls?: ReadonlyArray<{ name?: string | null }> | null;
  attachedFiles?: ReadonlyArray<{ size?: number | null }> | null;
};

const positive = (value: number | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The admin usage receipt's view of a chat turn. Reads only names, counts and sizes: tool arguments,
 * file names and message text never reach it, so the row cannot carry content.
 */
export function buildChatRequestMeta(input: ChatRequestMetaInput): IUsageEventRequestMeta {
  const toolCounts = new Map<string, number>();
  for (const call of input.functionCalls ?? []) {
    const name = call.name?.slice(0, TOOL_NAME_MAX);
    if (name) toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  const files = input.attachedFiles ?? [];
  const attachmentBytes = files.reduce((sum, file) => sum + (positive(file.size ?? undefined) ?? 0), 0);

  return {
    stopReason: input.stopReason ? input.stopReason.slice(0, STOP_REASON_MAX) : undefined,
    maxOutputTokens: positive(input.maxOutputTokens),
    creditCapOutputTokens: input.limiter?.cappedOutputTokens,
    stoppedForCredits: input.limiter?.stoppedForCredits || undefined,
    reasoningEffort: input.reasoningEffort ? input.reasoningEffort.slice(0, EFFORT_MAX) : undefined,
    thinkingBudgetTokens: positive(input.thinkingBudgetTokens),
    toolCalls: toolCounts.size > 0 ? [...toolCounts].map(([name, count]) => ({ name, count })) : undefined,
    attachmentCount: files.length > 0 ? files.length : undefined,
    attachmentBytes: files.length > 0 ? attachmentBytes : undefined,
  };
}
