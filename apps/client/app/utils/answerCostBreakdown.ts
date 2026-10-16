import type { IChatHistoryItem } from '@bike4mind/common';
import { formatAnswerCostAmount } from './formatCredits';
import { answeringModelId } from './answeringModel';

export interface AnswerCostPart {
  label: string;
  credits: number;
  /** The model behind the part, when the quest recorded it. */
  model?: string;
}

/**
 * Splits an answer's credits into the chat model's share and each charging tool's share, from the
 * amounts settlement already wrote to promptMeta (tokenUsage.creditsUsed for the chat model,
 * functionCalls[].creditsUsed per tool; ChatCompletionProcess sums them into quest.creditsUsed).
 * Display only. Empty when no tool charged, since the total is then the chat model's alone.
 */
export function answerCostBreakdown(
  promptMeta: IChatHistoryItem['promptMeta'],
  toolLabel: (toolName: string) => string
): AnswerCostPart[] {
  const tools = new Map<string, AnswerCostPart>();
  for (const call of promptMeta?.functionCalls ?? []) {
    if (!call.name || !call.creditsUsed || call.creditsUsed <= 0) continue;
    const model = typeof call.parameters?.model === 'string' ? call.parameters.model : undefined;
    const key = `${call.name}|${model ?? ''}`;
    const part = tools.get(key) ?? { label: toolLabel(call.name), credits: 0, model };
    part.credits += call.creditsUsed;
    tools.set(key, part);
  }
  if (tools.size === 0) return [];

  const chatCredits = promptMeta?.tokenUsage?.creditsUsed;
  const chat: AnswerCostPart[] =
    typeof chatCredits === 'number'
      ? [{ label: 'Chat', credits: chatCredits, model: answeringModelId(promptMeta) }]
      : [];
  return [...chat, ...tools.values()];
}

/** "Chat 64 + Image Generation 120", the split shown next to the answer's total. */
export function formatCostParts(parts: AnswerCostPart[]): string {
  return parts.map(part => `${part.label} ${formatAnswerCostAmount(part.credits)}`).join(' + ');
}
