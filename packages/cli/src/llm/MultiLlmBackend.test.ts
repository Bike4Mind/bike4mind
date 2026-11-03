import { describe, expect, it, vi } from 'vitest';
import type { IMessage, ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { MultiLlmBackend } from './MultiLlmBackend';

const model = (id: string) => ({ id }) as ModelInfo;

function backend(): ICompletionBackend {
  return {
    currentModel: '',
    complete: vi.fn(async () => undefined),
    pushToolMessages: vi.fn(),
    getModelInfo: vi.fn(async () => []),
  };
}

const tool = { id: 'call_1', name: 'file_read', parameters: '{}' };

describe('MultiLlmBackend', () => {
  it('sends tool results to the backend of the current model', () => {
    const [hosted, ollama, server] = [backend(), backend(), backend()];
    const multi = new MultiLlmBackend(
      hosted,
      [model('hosted-1')],
      [
        { backend: ollama, models: [model('tiny:1b')] },
        { backend: server, models: [model('local:srv-s1:qwen-small')] },
      ],
      'local:srv-s1:qwen-small'
    );
    const messages: IMessage[] = [];

    multi.pushToolMessages(messages, tool, 'ok');
    multi.currentModel = 'tiny:1b';
    multi.pushToolMessages(messages, tool, 'ok');
    multi.currentModel = 'hosted-1';
    multi.pushToolMessages(messages, tool, 'ok');

    expect(server.pushToolMessages).toHaveBeenCalledOnce();
    expect(ollama.pushToolMessages).toHaveBeenCalledOnce();
    expect(hosted.pushToolMessages).toHaveBeenCalledOnce();
  });

  it('routes and lists models of a backend added after startup, keeping the earlier route on a clash', async () => {
    const [hosted, first, late] = [backend(), backend(), backend()];
    const multi = new MultiLlmBackend(hosted, [model('hosted-1')], [{ backend: first, models: [model('a')] }], 'a');

    multi.addRoute({ backend: late, models: [model('a'), model('b')] });
    await multi.complete('a', [], {}, async () => undefined);
    await multi.complete('b', [], {}, async () => undefined);

    expect(first.complete).toHaveBeenCalledOnce();
    expect(late.complete).toHaveBeenCalledOnce();
    expect((await multi.getModelInfo()).map(m => m.id)).toEqual(['hosted-1', 'a', 'a', 'b']);
  });
});
