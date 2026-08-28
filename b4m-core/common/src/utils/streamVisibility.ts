/**
 * Which part of a streamed assistant reply the user actually sees.
 *
 * Reasoning-capable backends do not signal hidden thinking out-of-band; they wrap it in
 * these markers inside the streamed text itself (anthropicBackend.ts:1320,
 * bedrockBackend/anthropic.ts:1138, kimiBackend.ts:506, xaiBackend.ts:602,
 * ollamaBackend.ts:492). The markers are therefore the only cross-provider signal for
 * visibility, and the chat UI strips exactly this pair when rendering.
 */
export const THINK_OPEN_TAG = '<think>';
export const THINK_CLOSE_TAG = '</think>';

/**
 * The visible remainder of one reply slot, with hidden reasoning removed.
 *
 * This is the rule the chat transcript renders by - `extractReplies` in
 * apps/client/app/utils/replyUtils.ts calls straight into it, so the two cannot drift.
 * Anything deriving "did the user see something yet" (latency metrics in particular) must
 * use this and not a looser non-empty check: a metric built on a looser rule reports text
 * as seen while the UI is still hiding it.
 *
 * Faithfulness to the renderer is the contract, so two of its quirks are preserved on
 * purpose: text preceding a still-open thinking block stays visible (the UI shows it,
 * markers and all), and only the segment after the LAST close marker survives, because a
 * turn may open and close several thinking blocks before its answer.
 */
export function visibleReplyText(part: string | null | undefined): string {
  if (!part || !part.trim()) return '';

  if (part.includes(THINK_OPEN_TAG) && part.includes(THINK_CLOSE_TAG)) {
    return part.substring(part.lastIndexOf(THINK_CLOSE_TAG) + THINK_CLOSE_TAG.length).trim();
  }

  // Reaching here with an open marker means it is unclosed: the block is still streaming,
  // so nothing in this slot is renderable yet.
  if (part.startsWith(THINK_OPEN_TAG)) return '';

  return part;
}

/** Whether any slot of an in-progress reply carries text the user can see. */
export function hasVisibleReplyText(parts: readonly (string | null | undefined)[]): boolean {
  return parts.some(part => visibleReplyText(part).trim().length > 0);
}
