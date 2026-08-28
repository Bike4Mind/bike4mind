/**
 * Reply slots keyed by the provider's content-block index. Object rather than array because
 * indices are assigned by the provider and can skip.
 */
export type ReplySlots = { [index: number]: string };

/**
 * Folds one streamed chunk into the slots the transcript is rendered from.
 *
 * Extracted from the streaming callback in ChatCompletionProcess so both the transcript and
 * the TTFVT latency metric derive from one tested rule; the metric asks whether these slots
 * hold anything visible yet (see hasVisibleReplyText in @bike4mind/common).
 *
 * @param replies Mutated in place - a long-lived accumulator across the turn's chunks.
 * @param transitionMode Rapid-reply handoff mode. 'append' funnels every chunk into slot 0 so
 *   the model's answer continues the rapid reply already on screen, instead of opening a
 *   second bubble beside it.
 */
export function appendStreamedChunk(replies: ReplySlots, text: string, index: number, transitionMode: string): void {
  if (!text) return;

  if (transitionMode === 'append') {
    replies[0] ??= '';
    replies[0] += text;
    return;
  }

  replies[index] ??= '';

  // A thinking model that calls a tool restarts its content-block indices, so the visible
  // answer arrives at the SAME index as the thinking block that just closed. Appending it
  // there would bury the answer inside the collapsed reasoning block, so a slot that has
  // just closed its thinking spills into the next one.
  if (replies[index].endsWith('</think>')) {
    replies[index + 1] ??= '';
    replies[index + 1] += text;
    return;
  }

  replies[index] += text;
}

/**
 * The slots to judge "has the user seen anything from THIS model yet" from.
 *
 * Identical to the raw slots except in 'append' transition mode, where slot 0 is pre-seeded
 * with the rapid reply the user was shown BEFORE this model started streaming. Left in, that
 * prefix registers as the model's first visible token on a chunk that is still pure thinking,
 * which is the exact confusion TTFVT exists to avoid.
 *
 * Matched with startsWith rather than sliced blind: the retry paths clear the slots while
 * leaving the handoff flag set, so the prefix is not always present to strip.
 */
export function modelVisibleSlots(replies: ReplySlots, transitionMode: string, rapidReplyContent: string): string[] {
  const slots = Object.values(replies);
  if (transitionMode !== 'append' || !rapidReplyContent) return slots;

  const seededPrefix = `${rapidReplyContent} `;
  if (slots[0]?.startsWith(seededPrefix)) {
    slots[0] = slots[0].slice(seededPrefix.length);
  }
  return slots;
}
