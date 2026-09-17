import type { IMessage, MessageContent, MessageContentObject } from '../types/entities/MessageTypes';

/**
 * Canonicalize the multimodal `content` a wire caller may send into B4M's
 * MessageContentObject union, so every backend translator only has to read one
 * shape.
 *
 * `/api/ai/v1/completions` accepts an unvalidated content array
 * (CompletionMessageSchema's `z.array(z.any())`) and callers write it in
 * whichever dialect their SDK speaks: OpenAI Chat (`image_url`), OpenAI
 * Responses (`input_text`/`input_image`), or Anthropic (`image` + `source`).
 * Images always canonicalize to `image_url`, folding an Anthropic base64
 * source into a `data:` URL so every OpenAI-family translator (which reads
 * `image_url` only) sees the bytes too; `toAnthropicContent` reconstructs the
 * identical base64 source from that same data URL for the Anthropic target.
 *
 * Parts we do not recognize pass through untouched: a provider rejecting an
 * unknown block is a better failure than a silently missing one.
 */

type UnknownPart = Record<string, unknown>;

function asRecord(value: unknown): UnknownPart | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownPart) : null;
}

/** Pull the URL out of the several shapes an image part is written in. */
function imageUrlOf(part: UnknownPart): string | undefined {
  if (typeof part.image_url === 'string') return part.image_url;
  const nested = asRecord(part.image_url);
  if (nested && typeof nested.url === 'string') return nested.url;
  const source = asRecord(part.source);
  if (source && source.type === 'url' && typeof source.url === 'string') return source.url;
  if (source && source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
    return `data:${source.media_type};base64,${source.data}`;
  }
  return undefined;
}

function normalizeContentPart(part: unknown): unknown {
  if (typeof part === 'string') return { type: 'text', text: part };

  const record = asRecord(part);
  if (!record) return part;

  switch (record.type) {
    case 'text':
      return part;
    case 'input_text':
    case 'output_text':
      return typeof record.text === 'string' ? { ...record, type: 'text' } : part;

    case 'image':
    case 'image_url':
    case 'input_image': {
      const url = imageUrlOf(record);
      if (!url) return part;
      // `detail` rides inside image_url, which is where OpenAI Chat puts it and
      // what the Responses translator reads back out.
      const detail = asRecord(record.image_url)?.detail ?? record.detail;
      const { image_url: _imageUrl, source: _source, detail: _detail, ...rest } = record;
      return {
        ...rest,
        type: 'image_url',
        image_url: { url, ...(typeof detail === 'string' ? { detail } : {}) },
      };
    }

    default:
      return part;
  }
}

/** Returns `content` itself when nothing needed canonicalizing. */
export function normalizeMessageContent(content: MessageContent): MessageContent {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const normalized = content.map(part => {
    const next = normalizeContentPart(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? (normalized as MessageContentObject[]) : content;
}

/** Message-level wrapper over normalizeMessageContent; preserves identity when nothing changed. */
export function normalizeMultimodalMessages<T extends IMessage>(messages: T[]): T[] {
  return messages.map(message => {
    const content = normalizeMessageContent(message.content);
    return content === message.content ? message : { ...message, content };
  });
}
