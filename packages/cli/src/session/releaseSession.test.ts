import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseSession, type SessionResources } from './releaseSession.js';

afterEach(() => {
  vi.useRealTimers();
});

const jobs = [
  { id: 'a', status: 'running' },
  { id: 'b', status: 'queued' },
  { id: 'c', status: 'completed' },
];

/** The fakes, and the resources built from them with `over` applied. */
function resources(over: Partial<SessionResources> = {}) {
  const r = {
    killShellSessions: vi.fn(),
    killBangCommands: vi.fn(),
    commandHistory: { whenIdle: vi.fn(async () => {}) },
    saveSession: vi.fn(async () => {}),
    mcpManager: { disconnect: vi.fn(async () => {}) },
    featureRegistry: { disposeAll: vi.fn() },
    wsManager: { disconnect: vi.fn() },
    clearWebSocketToolExecutor: vi.fn(),
    stopBridgePresence: vi.fn(async () => {}),
    agent: { removeAllListeners: vi.fn() },
    backgroundManager: { listJobs: () => jobs, cancelJob: vi.fn(() => true) },
    imageStore: { close: vi.fn() },
  };
  return { r, input: { ...r, ...over } as SessionResources };
}

describe('releaseSession', () => {
  it('stops MCP servers, feature modules, agent listeners and background agents', async () => {
    const { r, input } = resources();

    await releaseSession(input, 1_000);

    expect(r.mcpManager.disconnect).toHaveBeenCalledOnce();
    expect(r.featureRegistry.disposeAll).toHaveBeenCalledOnce();
    expect(r.agent.removeAllListeners).toHaveBeenCalledOnce();
    expect(r.backgroundManager.cancelJob.mock.calls).toEqual([['a'], ['b']]);
    expect(r.wsManager.disconnect).toHaveBeenCalledOnce();
    expect(r.clearWebSocketToolExecutor).toHaveBeenCalledOnce();
    expect(r.saveSession).toHaveBeenCalledOnce();
    expect(r.stopBridgePresence).toHaveBeenCalledOnce();
    expect(r.killShellSessions).toHaveBeenCalledOnce();
    expect(r.imageStore.close).toHaveBeenCalledOnce();
  });

  it('keeps going when one step throws', async () => {
    const { r, input } = resources({
      featureRegistry: {
        disposeAll: () => {
          throw new Error('dispose failed');
        },
      },
      mcpManager: { disconnect: vi.fn(async () => Promise.reject(new Error('broken pipe'))) },
    });

    await releaseSession(input, 1_000);

    expect(r.agent.removeAllListeners).toHaveBeenCalledOnce();
    expect(r.backgroundManager.cancelJob).toHaveBeenCalledTimes(2);
  });

  it('stops waiting on an MCP server that never closes', async () => {
    vi.useFakeTimers();
    const { input } = resources({ mcpManager: { disconnect: () => new Promise<void>(() => {}) } });
    let done = false;

    const releasing = releaseSession(input, 300).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(299);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await releasing;

    expect(done).toBe(true);
  });
});
