import { describe, it, expect, vi } from 'vitest';
import { WebSocketToolExecutor } from './WebSocketToolExecutor';
import type { WebSocketConnectionManager } from './WebSocketConnectionManager';

type Reply = Record<string, unknown>;

/** A connection whose server answers the request with `reply` as soon as it is sent. */
function executorAnswering(reply: Reply) {
  let onReply: ((message: Reply) => void) | undefined;
  const manager = {
    isConnected: true,
    onRequest: vi.fn((_id: string, handler: (message: Reply) => void) => {
      onReply = handler;
    }),
    offRequest: vi.fn(),
    onDisconnect: vi.fn(),
    offDisconnect: vi.fn(),
    send: vi.fn(() => onReply?.({ action: 'cli_tool_response', ...reply })),
  };
  return new WebSocketToolExecutor(manager as unknown as WebSocketConnectionManager, async () => 'token');
}

describe('WebSocketToolExecutor', () => {
  it('resolves with the content of a successful call', async () => {
    const result = await executorAnswering({ success: true, content: 'results' }).execute('web_search', { query: 'q' });

    expect(result).toEqual({ success: true, content: 'results', error: undefined, errorCode: undefined });
  });

  it('carries the server error code through, so the router can tell an out-of-credits refusal', async () => {
    const result = await executorAnswering({
      success: false,
      error: 'You do not have enough credits for web search.',
      errorCode: 'insufficient_credits',
    }).execute('web_search', { query: 'q' });

    expect(result).toMatchObject({
      success: false,
      error: 'You do not have enough credits for web search.',
      errorCode: 'insufficient_credits',
    });
  });
});
