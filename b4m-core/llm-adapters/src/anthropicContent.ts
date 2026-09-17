import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import type { MessageContent } from '@bike4mind/common';

/** Data URLs carry the bytes inline; Anthropic wants them as a base64 source, not a url source. */
const DATA_URL = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s;

interface ContentLogger {
  warn: (message: string) => void;
}

/**
 * Translate canonical B4M content (see normalizeMultimodalMessages) into Anthropic
 * block params. Only `image_url` needs real work - Anthropic has no such block, so a
 * data URL becomes a base64 source and an http(s) URL becomes a url source. Every
 * other block (text, image, tool_use, tool_result, thinking) is already structurally
 * the SDK's shape and passes through with its `cache_control` stamp intact.
 *
 * An image we cannot translate is dropped with a warning: Anthropic rejects the whole
 * request over one unknown block, which would lose the text too.
 */
export function toAnthropicContent(content: MessageContent, logger?: ContentLogger): MessageParam['content'] {
  if (!Array.isArray(content)) return content as MessageParam['content'];

  const blocks: unknown[] = [];
  for (const block of content) {
    if (!block || block.type !== 'image_url') {
      blocks.push(block);
      continue;
    }

    const { image_url: imageUrl, type: _type, ...rest } = block;
    const url = imageUrl?.url;
    if (!url) {
      logger?.warn('[AnthropicBackend] Dropping image_url block with no url.');
      continue;
    }

    const dataUrl = DATA_URL.exec(url);
    if (dataUrl) {
      blocks.push({ ...rest, type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } });
    } else if (/^https?:\/\//i.test(url)) {
      blocks.push({ ...rest, type: 'image', source: { type: 'url', url } });
    } else {
      logger?.warn('[AnthropicBackend] Dropping image_url block; Anthropic accepts only http(s) or base64 data URLs.');
    }
  }

  // Anthropic rejects an empty `content` array outright; a dropped image should
  // degrade to a visible note, not an opaque 400 with nothing left to explain it.
  if (blocks.length === 0 && content.length > 0) {
    blocks.push({ type: 'text', text: '[image omitted: unsupported image format]' });
  }

  return blocks as MessageParam['content'];
}
