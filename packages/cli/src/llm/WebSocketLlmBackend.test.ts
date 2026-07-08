import { describe, it, expect, vi } from 'vitest';
import { WebSocketLlmBackend } from './WebSocketLlmBackend';
import { isTransientNetworkError } from './retryPolicy';
import type { WebSocketConnectionManager } from '../ws/WebSocketConnectionManager';
import type { ApiClient } from '../auth/ApiClient';
import type { CompletionRequest } from './streamTransport';
import type { StreamEvent } from './streamEvents';

vi.mock('../utils/Logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Lets the pending generator register its handlers and suspend before we emit. */
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

class FakeWsManager {
  connected = true;
  private handler?: (m: Record<string, unknown>) => void;
  private disconnectHandlers: Array<() => void> = [];

  get isConnected() {
    return this.connected;
  }
  onRequest(_id: string, h: (m: Record<string, unknown>) => void) {
    this.handler = h;
  }
  offRequest() {
    this.handler = undefined;
  }
  onDisconnect(h: () => void) {
    this.disconnectHandlers.push(h);
  }
  offDisconnect(h: () => void) {
    this.disconnectHandlers = this.disconnectHandlers.filter(x => x !== h);
  }
  emit(message: Record<string, unknown>) {
    this.handler?.(message);
  }
  dropConnection() {
    this.disconnectHandlers.forEach(h => h());
  }
}

const fakeApiClient = {
  getAxiosInstance: () => ({ post: () => Promise.resolve({}) }),
} as unknown as ApiClient;

const req: CompletionRequest = { model: 'test-model', messages: [], options: {} };

const makeBackend = (ws: FakeWsManager) =>
  new WebSocketLlmBackend({
    wsManager: ws as unknown as WebSocketConnectionManager,
    apiClient: fakeApiClient,
    model: 'test-model',
    tokenGetter: async () => 'token',
    wsCompletionUrl: '/ws-completions',
  });

/**
 * Adapter-level tests for the WebSocket transport seam: `open()` maps socket
 * frames to decoded events, ends on `cli_completion_done`, and throws on error /
 * disconnect. The accumulate/retry/finalize/empty policy is covered once in
 * runCompletion.test.ts - these just prove the frame mapping and, crucially, that
 * an empty done no longer silently resolves and a disconnect is now retryable.
 */
describe('WebSocketLlmBackend transport (open)', () => {
  it('yields decoded frames and ends on cli_completion_done', async () => {
    const ws = new FakeWsManager();
    const backend = makeBackend(ws);
    const events: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const event of backend.open(req)) events.push(event);
    })();

    await tick();
    ws.emit({ action: 'cli_completion_chunk', chunk: { type: 'content', text: 'Hi' } });
    ws.emit({ action: 'cli_completion_chunk', chunk: { type: 'content', text: ' there' } });
    ws.emit({ action: 'cli_completion_done' });
    await consumer;

    expect(events).toEqual([
      { type: 'content', text: 'Hi' },
      { type: 'content', text: ' there' },
    ]);
  });

  it('yields nothing and returns on an empty done (no silent blank-turn special-case)', async () => {
    const ws = new FakeWsManager();
    const backend = makeBackend(ws);
    const events: StreamEvent[] = [];
    const consumer = (async () => {
      for await (const event of backend.open(req)) events.push(event);
    })();

    await tick();
    ws.emit({ action: 'cli_completion_done' });
    await consumer;

    // The transport just ends; the core's empty-completion policy (retry, then
    // surface) is what prevents a blank turn - see runCompletion.test.ts.
    expect(events).toEqual([]);
  });

  it('throws a retryable "connection closed" error on a mid-stream disconnect', async () => {
    const ws = new FakeWsManager();
    const backend = makeBackend(ws);
    const consumer = (async () => {
      for await (const _event of backend.open(req)) void _event;
    })();

    await tick();
    ws.dropConnection();

    await expect(consumer).rejects.toThrow(/connection closed/i);
    // Being classified transient is what earns the WebSocket path its retries.
    expect(isTransientNetworkError(new Error('WebSocket connection closed during completion'))).toBe(true);
  });

  it('throws on a cli_completion_error frame', async () => {
    const ws = new FakeWsManager();
    const backend = makeBackend(ws);
    const consumer = (async () => {
      for await (const _event of backend.open(req)) void _event;
    })();

    await tick();
    ws.emit({ action: 'cli_completion_error', error: 'model overloaded' });

    await expect(consumer).rejects.toThrow('model overloaded');
  });

  it('throws immediately when the socket is not connected', async () => {
    const ws = new FakeWsManager();
    ws.connected = false;
    const backend = makeBackend(ws);
    const consumer = (async () => {
      for await (const _event of backend.open(req)) void _event;
    })();
    await expect(consumer).rejects.toThrow('WebSocket is not connected');
  });
});
