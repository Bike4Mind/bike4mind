import { BadRequestError, ChatModels, type IMessage } from '@bike4mind/common';
import { describe, expect, it, vi } from 'vitest';
import { AnthropicBackend } from './anthropicBackend';

const ERROR_MESSAGE = 'request must contain at least one non-empty user or assistant message';

function buildBackend() {
  const create = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }));
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const backend = new AnthropicBackend('test-key', logger as never);
  (backend as unknown as { _api: unknown })._api = { messages: { create } };
  return { backend, create, logger };
}

async function complete(backend: AnthropicBackend, messages: IMessage[]) {
  return backend.complete(ChatModels.CLAUDE_4_8_OPUS, messages, { stream: false }, async () => {});
}

describe('AnthropicBackend empty effective messages', () => {
  it.each([
    ['system-only', [{ role: 'system', content: 'system prompt' }] as IMessage[]],
    ['blank string', [{ role: 'user', content: '  \n ' }] as IMessage[]],
    ['blank text block', [{ role: 'assistant', content: [{ type: 'text', text: '\t' }] }] as IMessage[]],
  ])('rejects %s before the provider call', async (_label, messages) => {
    const { backend, create, logger } = buildBackend();

    await expect(complete(backend, messages)).rejects.toMatchObject({
      constructor: BadRequestError,
      statusCode: 400,
      message: ERROR_MESSAGE,
    });
    expect(create).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('continues to send a valid non-empty conversation unchanged', async () => {
    const { backend, create } = buildBackend();
    await complete(backend, [{ role: 'user', content: 'hello' }]);

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ messages: [{ role: 'user', content: 'hello' }] })
    );
  });
});
