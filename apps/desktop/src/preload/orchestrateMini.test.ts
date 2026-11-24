import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const exposed = vi.hoisted(() => new Map<string, unknown>());
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

const { ORCHESTRATE_MINI_CHANNELS } = await import('./orchestrateMini');

describe('the Orchestrate mini window preload', () => {
  it('spells each channel exactly as IPC_CHANNELS does', () => {
    for (const [name, channel] of Object.entries(ORCHESTRATE_MINI_CHANNELS)) {
      expect(IPC_CHANNELS[name as keyof typeof IPC_CHANNELS]).toBe(channel);
    }
  });

  it('exposes only the narrow b4mOrchestrateMini bridge, with nothing that answers or approves', () => {
    expect([...exposed.keys()]).toEqual(['b4mOrchestrateMini']);
    expect(Object.keys(exposed.get('b4mOrchestrateMini') as object).sort()).toEqual([
      'close',
      'focus',
      'getSnapshot',
      'onSnapshot',
    ]);
  });
});
