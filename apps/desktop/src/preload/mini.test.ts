import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const exposed = vi.hoisted(() => new Map<string, unknown>());
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => exposed.set(key, api) },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));

const { MINI_CHANNELS } = await import('./mini');

describe('the mini Tavern preload', () => {
  it('spells each channel exactly as IPC_CHANNELS does', () => {
    for (const [name, channel] of Object.entries(MINI_CHANNELS)) {
      expect(IPC_CHANNELS[name as keyof typeof IPC_CHANNELS]).toBe(channel);
    }
  });

  it('exposes only the narrow b4mMini bridge', () => {
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
