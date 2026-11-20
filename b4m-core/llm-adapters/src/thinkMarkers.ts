import { THINK_CLOSE_TAG, THINK_OPEN_TAG } from '@bike4mind/common';

/**
 * The text that ends a streamed thinking block, given what the marker escaper still holds and
 * whether the open marker went out.
 *
 * Adapters open the marker on the first reasoning text rather than on the block start: a model
 * whose thinking display is omitted streams a block carrying only a signature, and opening
 * eagerly persisted a bare `<think></think>` reply slot on every such turn. Returns '' when the
 * block produced no reasoning at all.
 */
export function closeThinkMarker(heldReasoning: string, opened: boolean): string {
  if (opened) return heldReasoning + THINK_CLOSE_TAG;
  return heldReasoning ? THINK_OPEN_TAG + heldReasoning + THINK_CLOSE_TAG : '';
}
