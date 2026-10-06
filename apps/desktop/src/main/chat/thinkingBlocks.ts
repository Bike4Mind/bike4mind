/**
 * The readable half of a provider's reasoning blocks.
 *
 * Anthropic's extended thinking arrives as blocks that have to be replayed verbatim or the next
 * request is rejected, which is why they are carried around as `unknown[]` and never rewritten.
 * They are not opaque, though: a `thinking` block holds the model's reasoning as plain text
 * beside the signature that makes it replayable, and nothing was reading it.
 *
 * This is the only reasoning a Claude turn ever yields. The think-filter path sees none of it -
 * the blocks ride the tool_use frame at the END of a round rather than the text stream - so a
 * round with thinking on this path knows what the model thought only once it has stopped.
 *
 * A redacted block carries encrypted `data` instead of text and is dropped: there is nothing in
 * it to read, and it still replays from the blocks themselves.
 */
export function readableThinking(blocks: readonly unknown[] | undefined): string {
  if (!blocks?.length) return '';
  return blocks
    .map(block =>
      block && typeof block === 'object' && typeof (block as { thinking?: unknown }).thinking === 'string'
        ? (block as { thinking: string }).thinking.trim()
        : ''
    )
    .filter(Boolean)
    .join('\n\n');
}
