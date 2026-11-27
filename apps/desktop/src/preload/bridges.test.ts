import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const exposed = vi.hoisted(() => new Map<string, unknown>());
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

beforeEach(() => {
  exposed.clear();
  vi.resetModules();
});

describe('the mini Tavern preload', () => {
  it('spells each channel exactly as IPC_CHANNELS does', async () => {
    const { MINI_CHANNELS } = await import('./mini');
    for (const [name, channel] of Object.entries(MINI_CHANNELS)) {
      expect(IPC_CHANNELS[name as keyof typeof IPC_CHANNELS]).toBe(channel);
    }
  });

  it('exposes only the narrow b4mMini bridge', async () => {
    await import('./mini');
    expect([...exposed.keys()]).toEqual(['b4mMini']);
    expect(Object.keys(exposed.get('b4mMini') as object).sort()).toEqual([
      'close',
      'focusAgent',
      'getSnapshot',
      'onSnapshot',
      'respond',
    ]);
  });
});

describe('the Orchestrate mini window preload', () => {
  it('spells each channel exactly as IPC_CHANNELS does', async () => {
    const { ORCHESTRATE_MINI_CHANNELS } = await import('./orchestrateMini');
    for (const [name, channel] of Object.entries(ORCHESTRATE_MINI_CHANNELS)) {
      expect(IPC_CHANNELS[name as keyof typeof IPC_CHANNELS]).toBe(channel);
    }
  });

  it('exposes only the narrow b4mOrchestrateMini bridge, with nothing that answers or approves', async () => {
    await import('./orchestrateMini');
    expect([...exposed.keys()]).toEqual(['b4mOrchestrateMini']);
    expect(Object.keys(exposed.get('b4mOrchestrateMini') as object).sort()).toEqual([
      'close',
      'focus',
      'getSnapshot',
      'onSnapshot',
    ]);
  });
});
