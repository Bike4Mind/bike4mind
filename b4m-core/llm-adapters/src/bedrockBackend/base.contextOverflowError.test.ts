import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@bike4mind/observability';
import { ChatModels } from '@bike4mind/common';
import LlamaBedrockBackend from './llama';

class TestLlamaBackend extends LlamaBedrockBackend {
  protected override updateClientForModel(): void {}
}

const validation = (message: string) => Object.assign(new Error(message), { name: 'ValidationException' });

const run = (backend: TestLlamaBackend, err: Error, content = 'hi') => {
  (backend as unknown as { _bedrockRuntime: unknown })._bedrockRuntime = {
    send: async () => {
      throw err;
    },
  };
  return backend.complete(
    ChatModels.LLAMA3_INSTRUCT_8B_V1,
    [{ role: 'user', content }],
    { stream: true, tools: [] },
    async () => {}
  );
};

describe('Bedrock context overflow mapping', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps the Llama "maximum context length" ValidationException to the context-overflow error', async () => {
    const err = validation(
      "This model's maximum context length is 8192 tokens. Please reduce the length of the prompt"
    );
    await expect(run(new TestLlamaBackend(), err)).rejects.toThrow(/^Context overflow:/);
  });

  it('leaves unrelated ValidationExceptions untouched', async () => {
    const err = validation('malformed input request');
    await expect(run(new TestLlamaBackend(), err)).rejects.toBe(err);
  });

  it('never logs prompt text when an invoke fails', async () => {
    const spy = vi.spyOn(Logger.globalInstance, 'error').mockImplementation(() => {});
    await run(new TestLlamaBackend(), new Error('boom'), 'TOP-SECRET-PROMPT').catch(() => {});
    expect(JSON.stringify(spy.mock.calls)).not.toContain('TOP-SECRET-PROMPT');
  });

  it('rejects oversized Llama 3 prompts before calling Bedrock', async () => {
    const send = vi.fn().mockRejectedValue(new Error('should not be reached'));
    const backend = new TestLlamaBackend();
    (backend as unknown as { _bedrockRuntime: unknown })._bedrockRuntime = { send };
    await expect(
      backend.complete(
        ChatModels.LLAMA3_INSTRUCT_8B_V1,
        [{ role: 'user', content: 'x'.repeat(80_000) }],
        { stream: true, tools: [] },
        async () => {}
      )
    ).rejects.toThrow(/^Context overflow:/);
    expect(send).not.toHaveBeenCalled();
  });
});
