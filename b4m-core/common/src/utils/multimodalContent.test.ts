import { describe, it, expect } from 'vitest';
import { normalizeMessageContent, normalizeMultimodalMessages } from './multimodalContent';
import type { IMessage } from '../types/entities/MessageTypes';

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';

describe('normalizeMessageContent', () => {
  it('leaves string content alone', () => {
    expect(normalizeMessageContent('hello')).toBe('hello');
  });

  it('returns the same array when nothing needs canonicalizing', () => {
    const content = [{ type: 'text' as const, text: 'hi' }];
    expect(normalizeMessageContent(content)).toBe(content);
  });

  it('canonicalizes OpenAI Chat image parts', () => {
    expect(
      normalizeMessageContent([
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: DATA_URL, detail: 'high' } },
      ] as never)
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: DATA_URL, detail: 'high' } },
    ]);
  });

  it('canonicalizes OpenAI Responses parts', () => {
    expect(
      normalizeMessageContent([
        { type: 'input_text', text: 'what is this?' },
        { type: 'input_image', image_url: DATA_URL, detail: 'low' },
      ] as never)
    ).toEqual([
      { type: 'text', text: 'what is this?' },
      { type: 'image_url', image_url: { url: DATA_URL, detail: 'low' } },
    ]);
  });

  it('canonicalizes an Anthropic url image source', () => {
    expect(
      normalizeMessageContent([{ type: 'image', source: { type: 'url', url: 'https://x.test/a.png' } }] as never)
    ).toEqual([{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }]);
  });

  it('leaves an inline base64 image untouched', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } };
    expect(normalizeMessageContent([block] as never)[0]).toBe(block);
  });

  it('wraps a bare string part as a text block', () => {
    expect(normalizeMessageContent(['hi'] as never)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('preserves cache_control and passes unrecognized parts through', () => {
    const passthrough = { type: 'input_file', file_id: 'f_1' };
    expect(
      normalizeMessageContent([
        { type: 'input_image', image_url: DATA_URL, cache_control: { type: 'ephemeral' } },
        passthrough,
      ] as never)
    ).toEqual([{ type: 'image_url', image_url: { url: DATA_URL }, cache_control: { type: 'ephemeral' } }, passthrough]);
  });

  it('leaves tool blocks alone', () => {
    const content = [
      { type: 'tool_use' as const, id: 't1', name: 'search', input: {} },
      { type: 'tool_result' as const, tool_use_id: 't1', content: 'ok' },
    ];
    expect(normalizeMessageContent(content)).toBe(content);
  });
});

describe('normalizeMultimodalMessages', () => {
  it('rewrites only the messages that changed', () => {
    const plain: IMessage = { role: 'user', content: 'hello' };
    const multimodal: IMessage = {
      role: 'user',
      content: [{ type: 'input_image', image_url: DATA_URL }] as never,
    };
    const [first, second] = normalizeMultimodalMessages([plain, multimodal]);

    expect(first).toBe(plain);
    expect(second).not.toBe(multimodal);
    expect(second.content).toEqual([{ type: 'image_url', image_url: { url: DATA_URL } }]);
  });
});
