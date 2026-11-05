import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundAgentManager } from '../agents/BackgroundAgentManager.js';
import type { SubagentOrchestrator } from '../agents/SubagentOrchestrator.js';
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
    abortTurn: vi.fn(),
    killShellSessions: vi.fn(() => 0),
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
    expect(r.abortTurn).toHaveBeenCalledOnce();
    expect(r.backgroundManager.cancelJob.mock.calls).toEqual([['b'], ['a']]);
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

  it('cancels queued background agents before running ones, so none starts during release', async () => {
    const delegateToAgent = vi.fn(
      ({ abortSignal }: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => abortSignal.addEventListener('abort', () => reject(new Error('aborted'))))
    );
    const manager = new BackgroundAgentManager({ delegateToAgent } as unknown as SubagentOrchestrator, 1);
    const spawn = { task: 't', agentName: 'a', parentSessionId: 's', resumeId: 'r' };
    manager.spawn(spawn);
    manager.spawn(spawn);
    const { input } = resources({ backgroundManager: manager });

    await releaseSession(input, 1_000);

    expect(delegateToAgent).toHaveBeenCalledOnce();
    expect(manager.listJobs().map(job => job.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('aborts the turn in flight first', async () => {
    const order: string[] = [];
    const { input } = resources({
      abortTurn: () => void order.push('turn'),
      backgroundManager: { listJobs: () => jobs, cancelJob: id => Boolean(order.push(`job ${id}`)) },
    });

    await releaseSession(input, 1_000);

    expect(order[0]).toBe('turn');
  });

  it('reports how many background shells it stopped', async () => {
    expect(await releaseSession(resources({ killShellSessions: () => 2 }).input, 1_000)).toEqual({ shellsStopped: 2 });
    const failing = resources({
      killShellSessions: () => {
        throw new Error('no such process group');
      },
    });
    expect(await releaseSession(failing.input, 1_000)).toEqual({ shellsStopped: 0 });
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
