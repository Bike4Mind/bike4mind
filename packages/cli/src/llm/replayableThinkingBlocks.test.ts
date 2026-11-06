import type { IMessage } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../auth/ApiClient';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import { ServerLlmBackend } from './ServerLlmBackend';
import { WebSocketLlmBackend } from './WebSocketLlmBackend';

// pushToolMessages never touches the network; the base URL only satisfies the SDK constructor.
const apiClient = { baseURL: 'http://localhost:3000', fetch } as unknown as ApiClient;

const backends = [
  ['ServerLlmBackend', () => new ServerLlmBackend({ apiClient, model: 'kimi-k3' })],
  [
    'WebSocketLlmBackend',
    () =>
      new WebSocketLlmBackend({
        wsManager: {} as unknown as WebSocketConnectionManager,
        apiClient,
        model: 'kimi-k3',
        tokenGetter: async () => 'token',
        wsCompletionUrl: '/ws-completions',
      }),
  ],
] as const;

const tool = { id: 't1', name: 'search', parameters: '{"q":"a"}' };

describe.each(backends)('%s.pushToolMessages thinking replay', (_name, makeBackend) => {
  it('never replays a bare-string reasoning trace as assistant content', () => {
    // Kimi's executeTools:false emit carries raw reasoning_content as a string.
    // Spliced into content, the server normalizes it to a text block and sends
    // the private monologue to the provider as visible assistant text.
    const messages: IMessage[] = [];
    makeBackend().pushToolMessages(messages, tool, 'result', ['private reasoning']);

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } }],
    });
    expect(JSON.stringify(messages)).not.toContain('private reasoning');
  });

  it('still replays structured thinking blocks ahead of the tool_use', () => {
    const thinking = { type: 'thinking', thinking: 'plan', signature: 'sig' };
    const messages: IMessage[] = [];
    makeBackend().pushToolMessages(messages, tool, 'result', [thinking]);

    expect(messages[0].content).toEqual([thinking, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'a' } }]);
  });
});
