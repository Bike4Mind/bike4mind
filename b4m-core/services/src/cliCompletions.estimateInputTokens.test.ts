import { describe, expect, it } from 'vitest';
import { normalizeMultimodalMessages, type IMessage } from '@bike4mind/common';
import { estimateInputTokens, IMAGE_INPUT_TOKEN_ESTIMATE } from './cliCompletions';

// A pasted screenshot as the CLI sends it: about 1 MB of base64.
const SCREENSHOT_BASE64 = 'A'.repeat(1_000_000);

const userImageMessage = (data: string): IMessage => ({
  role: 'user',
  content: [
    { type: 'text', text: 'what is wrong here?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] as unknown as IMessage['content'],
});

describe('estimateInputTokens', () => {
  it('estimates plain text at 2.5 characters per token', () => {
    expect(estimateInputTokens([{ role: 'user', content: 'x'.repeat(250) }])).toBe(100);
  });

  it('prices an inline image at a fixed estimate, not at its base64 length', () => {
    const [message] = normalizeMultimodalMessages([userImageMessage(SCREENSHOT_BASE64)]);
    const tokens = estimateInputTokens([message]);

    expect(tokens).toBeGreaterThanOrEqual(IMAGE_INPUT_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(IMAGE_INPUT_TOKEN_ESTIMATE + 100);
  });

  it('does not depend on the image byte size', () => {
    const small = estimateInputTokens(normalizeMultimodalMessages([userImageMessage('A'.repeat(1_000))]));
    const large = estimateInputTokens(normalizeMultimodalMessages([userImageMessage(SCREENSHOT_BASE64)]));

    expect(large).toBe(small);
  });

  it('counts every image, including ones nested in a tool result', () => {
    const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${SCREENSHOT_BASE64}` } };
    const messages = [
      { role: 'user', content: [imagePart, imagePart] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: [imagePart] }],
      },
    ] as unknown as IMessage[];

    const tokens = estimateInputTokens(messages);

    expect(tokens).toBeGreaterThanOrEqual(3 * IMAGE_INPUT_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(3 * IMAGE_INPUT_TOKEN_ESTIMATE + 200);
  });

  it('prices raw Anthropic and Responses image parts without normalization', () => {
    const messages = [
      {
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: SCREENSHOT_BASE64 } }],
      },
      {
        role: 'user',
        content: [{ type: 'input_image', image_url: `data:image/png;base64,${SCREENSHOT_BASE64}` }],
      },
    ] as unknown as IMessage[];

    const tokens = estimateInputTokens(messages);

    expect(tokens).toBeGreaterThanOrEqual(2 * IMAGE_INPUT_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(2 * IMAGE_INPUT_TOKEN_ESTIMATE + 200);
  });

  it('still prices the text around an image', () => {
    const withText: IMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'y'.repeat(25_000) },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ] as unknown as IMessage['content'],
    };

    expect(estimateInputTokens([withText])).toBeGreaterThanOrEqual(10_000 + IMAGE_INPUT_TOKEN_ESTIMATE);
  });
});
