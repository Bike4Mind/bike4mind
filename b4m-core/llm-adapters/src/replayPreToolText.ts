import type { IMessage } from '@bike4mind/common';

/**
 * The round's streamed text when it is worth replaying, else undefined: whitespace-only text
 * carries nothing the model could restate, and an empty `content` on the tool-call message is
 * the valid shape.
 */
export function replayableText(text: string | null | undefined): string | undefined {
  return typeof text === 'string' && text.trim().length > 0 ? text : undefined;
}

/**
 * Puts the text a model wrote ahead of its tool calls back on the assistant message that
 * carries those calls. Without it the next request shows `content: null` plus `tool_calls`,
 * the model never sees its own preamble and restates it, and the append-only reply
 * accumulator then holds the text twice.
 *
 * `fromIndex` is `messages.length` captured before the round's `pushToolMessages` calls. Only
 * the first assistant message of the round gets the text, so a round split into one assistant
 * message per call does not repeat it per call. A message that already has content is left
 * alone.
 */
export function attachPreToolText(messages: IMessage[], fromIndex: number, text: string | null | undefined): void {
  const replay = replayableText(text);
  if (!replay) return;
  const first = messages[fromIndex] as (IMessage & { tool_calls?: unknown[] }) | undefined;
  if (first?.role !== 'assistant' || !Array.isArray(first.tool_calls)) return;
  if (typeof first.content === 'string' ? first.content.trim() : first.content) return;
  first.content = replay;
}
