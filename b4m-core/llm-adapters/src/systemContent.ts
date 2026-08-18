import type { MessageContent } from '@bike4mind/common';

/**
 * Flatten a system message's content to the plain text a provider should receive.
 *
 * System content is usually a string, but the assembly pipeline can hand back an
 * array of content blocks. Both Anthropic-family adapters previously coerced that
 * array with `JSON.stringify` (or bare `String()`), which sent the model literal
 * JSON syntax - escaped quotes and `type`/`text` keys - in place of the prompt.
 *
 * Only `text` blocks are read: Anthropic's `system` accepts text only, so an image
 * or tool block there is already invalid and is dropped rather than serialized into
 * the prompt. Blocks are joined on a newline, matching how separate system messages
 * are joined by the callers.
 */
export function systemContentToText(content: MessageContent | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block?.type === 'text')
    .map(block => block.text ?? '')
    .filter(text => text !== '')
    .join('\n');
}
