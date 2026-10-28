import { IPC_CHANNELS } from '@shared/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelHubServiceDeps } from './ModelHubService';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn() },
}));
const send = vi.hoisted(() => vi.fn());
const service = vi.hoisted(() => ({ deps: null as ModelHubServiceDeps | null, serverChanged: vi.fn() }));

vi.mock('electron', () => electron);
vi.mock('../windows', () => ({ appWindows: () => [{ webContents: { send } }] }));
vi.mock('./ModelHubService', () => ({
  ModelHubService: class {
    serverChanged = service.serverChanged;
    constructor(deps: ModelHubServiceDeps) {
      service.deps = deps;
    }
  },
}));

const { registerModels } = await import('./index');

function setup() {
  let saved: ((id: string) => void) | null = null;
  const servers = {
    // Not used by registerModels; here so a send after a recheck would show up as a second call.
    check: vi.fn(async () => []),
    hubServer: vi.fn(() => null),
    onServerSaved: vi.fn((listener: (id: string) => void) => {
      saved = listener;
      return () => {};
    }),
  };
  registerModels(servers);
  const deps = service.deps;
  if (!deps) throw new Error('ModelHubService was not built');
  return { deps, saved: (id: string) => saved?.(id) };
}

beforeEach(() => {
  vi.clearAllMocks();
  service.deps = null;
});

describe('registerModels', () => {
  it('announces a changed server once, right away, with its id', async () => {
    const { deps } = setup();
    deps.onInstalledChanged('srv1');
    expect(send.mock.calls).toEqual([[IPC_CHANNELS.modelsInstalledChanged, 'srv1']]);
    deps.onInstalledChanged('local');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(send.mock.calls).toEqual([
      [IPC_CHANNELS.modelsInstalledChanged, 'srv1'],
      [IPC_CHANNELS.modelsInstalledChanged, 'local'],
    ]);
  });

  it('holds one power save blocker while server pulls run and releases it after', () => {
    const { deps } = setup();
    deps.keepAwake?.(true);
    deps.keepAwake?.(true);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledTimes(1);
    expect(electron.powerSaveBlocker.start).toHaveBeenCalledWith('prevent-app-suspension');

    deps.keepAwake?.(false);
    deps.keepAwake?.(false);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledTimes(1);
    expect(electron.powerSaveBlocker.stop).toHaveBeenCalledWith(7);
  });

  it('tells the service when Settings saves or removes a server', () => {
    const { saved } = setup();
    saved('srv1');
    expect(service.serverChanged).toHaveBeenCalledWith('srv1');
  });
});
