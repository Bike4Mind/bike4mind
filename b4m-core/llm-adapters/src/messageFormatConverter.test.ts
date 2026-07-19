import { describe, it, expect } from 'vitest';
import { convertMessagesToOpenAIFormat } from './messageFormatConverter';
import type { IMessage } from '@bike4mind/common';

/**
 * Regression guard: the converter only rewrites tool_use/tool_result blocks. A
 * multimodal user message (image_url or inline image) carries no such block and
 * MUST pass through unchanged so OpenAI and xAI still receive the image content.
 * The Ollama backend does its own image mapping downstream in buildMessages.
 */
describe('convertMessagesToOpenAIFormat - image content pass-through', () => {
  it('passes a user message with an image_url block through unchanged', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([message]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(message);
  });

  it('passes a user message with an inline base64 image block through unchanged', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' } },
      ],
    } as IMessage;

    const result = convertMessagesToOpenAIFormat([message]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe(message);
  });
});
