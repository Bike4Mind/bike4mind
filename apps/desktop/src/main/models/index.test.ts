import { IPC_CHANNELS } from '@shared/ipc';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { CuratedSourceView, HfTokenResult } from '@shared/models';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelHubServiceDeps } from './ModelHubService';

type Handler = (event: { sender: { id: number } }, value?: unknown) => unknown;
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  app: { getPath: () => '/unused/test-user-data', getVersion: () => '0.1.12', isPackaged: true },
  ipcMain: { handle: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 7), stop: vi.fn() },
  safeStorage: {},
}));
const { origin, other, sourceView } = vi.hoisted(() => ({
  sourceView: vi.fn(),
  origin: { webContents: { id: 1, send: vi.fn() } },
  other: { webContents: { id: 2, send: vi.fn() } },
}));
const service = vi.hoisted(() => ({
  deps: null as ModelHubServiceDeps | null,
  serverChanged: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  curated: vi.fn(),
}));

vi.mock('electron', () => electron);
vi.mock('./curated/CuratedSource', () => ({
  CuratedSource: class {
    current = vi.fn();
    loaded = async () => {};
    checkIfDue = async () => {};
    view = sourceView;
  },
}));
vi.mock('../windows', () => ({ appWindows: () => [origin, other] }));
vi.mock('./ModelHubService', () => ({
  ModelHubService: class {
    serverChanged = service.serverChanged;
    setToken = service.setToken;
    clearToken = service.clearToken;
    curated = service.curated;
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
    specs: vi.fn(() => null),
    onServerSaved: vi.fn((listener: (id: string) => void) => {
      saved = listener;
      return () => {};
    }),
  };
  registerModels(servers, { localContext: async () => AUTO_LOCAL_CONTEXT });
  const deps = service.deps;
  if (!deps) throw new Error('ModelHubService was not built');
  return { deps, saved: (id: string) => saved?.(id) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__B4M_CURATED_DEV_KEYS__', false);
  sourceView.mockReset().mockReturnValue({
    origin: 'bundled',
    sequence: 1,
    check: 'idle',
    checkedAt: null,
    stale: false,
  } satisfies CuratedSourceView);
  electron.handlers.clear();
  electron.ipcMain.handle.mockImplementation((channel: string, handler: Handler) => {
    electron.handlers.set(channel, handler);
  });
  service.deps = null;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerModels', () => {
  it('announces a changed server once, right away, with its id', async () => {
    const { deps } = setup();
    const send = origin.webContents.send;
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

describe('Models credential IPC', () => {
  it.each([
    [IPC_CHANNELS.modelsSaveHfAccess, true],
    [IPC_CHANNELS.modelsClearHfAccess, false],
  ])('broadcasts only the successful status to other windows for %s', async (channel, set) => {
    const result: HfTokenResult = { ok: true, status: { set, persisted: true } };
    service.setToken.mockResolvedValue(result);
    service.clearToken.mockResolvedValue(result);
    setup();
    const response = await electron.handlers.get(channel)?.({ sender: { id: 1 } }, 'hf_secret_never_broadcast');
    expect(response).toEqual(result);
    expect(origin.webContents.send).not.toHaveBeenCalled();
    expect(other.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.modelsHfAccessChanged, result.status);
    expect(JSON.stringify(other.webContents.send.mock.calls)).not.toContain('hf_secret_never_broadcast');
    if (set) expect(service.setToken).toHaveBeenCalledWith('hf_secret_never_broadcast');
  });

  it.each([IPC_CHANNELS.modelsSaveHfAccess, IPC_CHANNELS.modelsClearHfAccess])(
    'does not broadcast a failed mutation for %s',
    async channel => {
      const result: HfTokenResult = { ok: false, error: { kind: 'failed', message: 'Could not write.' } };
      service.setToken.mockResolvedValue(result);
      service.clearToken.mockResolvedValue(result);
      setup();
      expect(await electron.handlers.get(channel)?.({ sender: { id: 1 } }, 'hf_secret_never_broadcast')).toEqual(
        result
      );
      expect(origin.webContents.send).not.toHaveBeenCalled();
      expect(other.webContents.send).not.toHaveBeenCalled();
    }
  );
});

describe('Models curated IPC', () => {
  const list = {
    updatedAt: '2026-10-27T00:00:00Z',
    machine: { memoryKind: 'cpu', totalMemoryBytes: 16 * 1024 ** 3, gpuMemoryBytes: null, gpuName: null },
    entries: [],
    picks: [],
  };

  it('keeps source metadata with the manifest snapshot while model probes are pending', async () => {
    const bundledView = sourceView();
    let finish: (() => void) | undefined;
    service.curated.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return list;
    });
    setup();
    const response = electron.handlers.get(IPC_CHANNELS.modelsListCurated)?.({ sender: { id: 1 } });
    await vi.waitFor(() => expect(service.curated).toHaveBeenCalledOnce());
    sourceView.mockReturnValue({ ...bundledView, origin: 'updated', sequence: 2, check: 'updated' });
    if (!finish) throw new Error('The curated probe never started');
    finish();
    await expect(response).resolves.toMatchObject({ source: bundledView });
  });

  it('lists curated models for the chosen server and refuses a malformed server id', async () => {
    service.curated.mockResolvedValue(list);
    setup();
    const handler = electron.handlers.get(IPC_CHANNELS.modelsListCurated);
    await handler?.({ sender: { id: 1 } }, 'srv1');
    expect(service.curated).toHaveBeenLastCalledWith('srv1');
    await handler?.({ sender: { id: 1 } });
    expect(service.curated).toHaveBeenLastCalledWith(undefined);
    await expect(handler?.({ sender: { id: 1 } }, 42)).resolves.toMatchObject({ ok: false });
    expect(service.curated).toHaveBeenCalledTimes(2);
  });
});
