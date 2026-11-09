import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }));

import { BOOT_TIMEOUT_MS, BUILD_TIMEOUT_MESSAGE, BUILD_TIMEOUT_MS, resolveEngineAsset } from './engineProtocol';

type Posted = { type: string; id?: number; outcome?: { ok: boolean; error?: string } };

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  received: Array<{ type: string; wasm?: unknown }> = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(data: { type: string }): void {
    this.received.push(data);
  }
  terminate(): void {
    this.terminated = true;
  }
  ready(): void {
    this.onmessage?.({ data: { type: 'ready' } });
  }
  answer(outcome: unknown): void {
    this.onmessage?.({ data: outcome });
  }
  get builds(): number {
    return this.received.filter(message => message.type === 'build').length;
  }
}

const COMPILED = { compiled: 'manifold' };

/**
 * Runs the real engine page script against stand-ins for the browser APIs it touches: Worker,
 * WebAssembly.compileStreaming, fetch and the parent window. Timers are vitest's fake ones.
 */
function startEngine() {
  const asset = resolveEngineAsset('/engine.js');
  if (asset?.kind !== 'inline') throw new Error('engine.js is not served inline');
  const parent = { postMessage: vi.fn<(data: Posted) => void>() };
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const window = {
    parent,
    addEventListener: (_type: string, listener: typeof onMessage) => {
      onMessage = listener;
    },
  };
  const WebAssembly = { compileStreaming: () => Promise.resolve(COMPILED) };
  const fetch = () => Promise.resolve({});
  new Function('window', 'Worker', 'WebAssembly', 'fetch', asset.body)(window, FakeWorker, WebAssembly, fetch);
  const send = (id: number) => onMessage?.({ source: parent, data: { type: 'build', id, source: 'x', params: {} } });
  const replies = () => parent.postMessage.mock.calls.map(([data]) => data).filter(data => data.type === 'built');
  return { send, replies };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

describe('engine page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWorker.all = [];
  });
  afterEach(() => vi.useRealTimers());

  it('warms a worker with the page-compiled WASM before any build is asked for', async () => {
    startEngine();
    await settle();
    expect(FakeWorker.all).toHaveLength(1);
    expect(FakeWorker.all[0].received).toEqual([{ type: 'init', wasm: COMPILED }]);
  });

  it('starts the build budget only once the worker is ready, so a slow cold boot does not time out', async () => {
    const { send, replies } = startEngine();
    await settle();
    send(1);
    await settle();
    // Longer than a build's budget, still inside the boot ceiling.
    await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS * 2);
    const [cold] = FakeWorker.all;
    expect(cold.builds).toBe(0);
    cold.ready();
    await settle();
    expect(cold.builds).toBe(1);
    await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS - 1);
    cold.answer({ ok: true, parts: [] });
    expect(replies()).toEqual([{ type: 'built', id: 1, outcome: { ok: true, parts: [] } }]);
  });

  it('still kills a model that never returns, BUILD_TIMEOUT_MS after it started', async () => {
    const { send, replies } = startEngine();
    await settle();
    FakeWorker.all[0].ready();
    send(1);
    await settle();
    await vi.advanceTimersByTimeAsync(BUILD_TIMEOUT_MS);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(replies()).toEqual([{ type: 'built', id: 1, outcome: { ok: false, error: BUILD_TIMEOUT_MESSAGE } }]);
  });

  it('gives up on a worker that never becomes ready at the boot ceiling', async () => {
    const { send, replies } = startEngine();
    await settle();
    send(1);
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
    expect(FakeWorker.all[0].terminated).toBe(true);
    expect(replies()[0].outcome).toEqual({ ok: false, error: expect.stringContaining('did not start') });
  });

  it('runs the next build on the worker warmed while the previous one ran, never on a used one', async () => {
    const { send, replies } = startEngine();
    await settle();
    FakeWorker.all[0].ready();
    send(1);
    await settle();
    expect(FakeWorker.all).toHaveLength(2);
    FakeWorker.all[1].ready();
    FakeWorker.all[0].answer({ ok: true, parts: [] });
    send(2);
    await settle();
    expect(FakeWorker.all[1].builds).toBe(1);
    expect(FakeWorker.all[0].builds).toBe(1);
    expect(FakeWorker.all[0].terminated).toBe(true);
    FakeWorker.all[1].answer({ ok: true, parts: [] });
    expect(replies().map(reply => reply.id)).toEqual([1, 2]);
  });

  it('hands a booting worker to the build that supersedes the one waiting on it', async () => {
    const { send, replies } = startEngine();
    await settle();
    send(1);
    send(2);
    await settle();
    FakeWorker.all[0].ready();
    await settle();
    expect(FakeWorker.all[0].builds).toBe(1);
    FakeWorker.all[0].answer({ ok: true, parts: [] });
    expect(replies().map(reply => reply.id)).toEqual([2]);
  });
});
