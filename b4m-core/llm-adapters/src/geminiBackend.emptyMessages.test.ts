import { BadRequestError, ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { GeminiBackend } from './geminiBackend';

const ERROR_MESSAGE = 'request must contain at least one non-empty user or assistant message';

function buildBackend() {
  const generateContentStream = vi.fn(async () =>
    (async function* () {
      yield {
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      };
    })()
  );
  const backend = new GeminiBackend('test-key');
  (backend as unknown as { _api: unknown })._api = { models: { generateContentStream } };
  return { backend, generateContentStream };
}

async function complete(backend: GeminiBackend, messages: IMessage[]) {
  return backend.complete(ChatModels.GEMINI_2_5_FLASH_LITE, messages, { stream: true }, async () => {});
}

describe('GeminiBackend empty effective messages', () => {
  it.each([
    ['system-only', [{ role: 'system', content: 'system prompt' }] as IMessage[]],
    ['blank string', [{ role: 'user', content: '  \n ' }] as IMessage[]],
    ['blank text block', [{ role: 'assistant', content: [{ type: 'text', text: '\t' }] }] as IMessage[]],
  ])('rejects %s before the provider call', async (_label, messages) => {
    const { backend, generateContentStream } = buildBackend();

    await expect(complete(backend, messages)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: 400,
      message: ERROR_MESSAGE,
    });
    expect(generateContentStream).not.toHaveBeenCalled();
  });

  it('continues to send a valid non-empty conversation unchanged', async () => {
    const { backend, generateContentStream } = buildBackend();
    await complete(backend, [{ role: 'user', content: 'hello' }]);

    expect(generateContentStream).toHaveBeenCalledOnce();
    expect(generateContentStream.mock.calls[0][0]).toEqual(
      expect.objectContaining({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] })
    );
  });
});
