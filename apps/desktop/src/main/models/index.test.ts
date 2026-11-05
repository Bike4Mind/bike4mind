import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { IPC_CHANNELS } from '@shared/ipc';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { CapabilityScope } from '@shared/capabilities';
import type { CuratedSourceView, HfTokenResult, ModelPull } from '@shared/models';
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
  pulls: vi.fn(() => [] as ModelPull[]),
  storeLocation: vi.fn(),
}));
const ledger = {
  grant: vi.fn(async (input: { scope: CapabilityScope }) => ({ id: 'g1', scope: input.scope })),
  use: vi.fn(async () => {}),
  revokeMatching: vi.fn(async () => []),
};

const SERVICE_STORE = '/usr/share/ollama/.ollama/models';
const fsState = vi.hoisted(() => ({ serviceStore: false }));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (path: string) =>
      path === '/usr/share/ollama/.ollama/models' ? fsState.serviceStore : actual.existsSync(path),
  };
});
vi.mock('electron', () => electron);
vi.mock('@bike4mind/local-models', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/local-models')>()),
  CuratedListSource: class {
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
    pulls = service.pulls;
    storeLocation = service.storeLocation;
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
  registerModels(
    servers,
    { localContext: async () => AUTO_LOCAL_CONTEXT },
    ledger as unknown as Parameters<typeof registerModels>[2]
  );
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

  it.runIf(process.platform === 'linux')(
    "guesses the Linux service's model folder when it exists, before the home folder",
    () => {
      vi.stubEnv('OLLAMA_MODELS', '');
      const { deps } = setup();
      fsState.serviceStore = true;
      expect(deps.defaultStoreDir?.()).toBe(SERVICE_STORE);
      fsState.serviceStore = false;
      expect(deps.defaultStoreDir?.()).toMatch(/\.ollama[\\/]models$/);
      expect(deps.defaultStoreDir?.()).not.toBe(SERVICE_STORE);
      vi.stubEnv('OLLAMA_MODELS', '/data/models');
      expect(deps.defaultStoreDir?.()).toBe('/data/models');
      vi.unstubAllEnvs();
    }
  );

  it('measures free space for a model folder Ollama has not made yet on the disk that will hold it', async () => {
    const { deps } = setup();
    const missing = join(tmpdir(), `b4m-no-models-${process.pid}`, '.ollama', 'models');
    expect(existsSync(missing)).toBe(false);
    await expect(deps.freeSpace?.(missing)).resolves.toBeGreaterThan(0);
  });

  it.runIf(process.platform !== 'darwin')(
    'stages split imports under the cache variable only when it is absolute',
    () => {
      const key = process.platform === 'win32' ? 'LOCALAPPDATA' : 'XDG_CACHE_HOME';
      const absolute = join(tmpdir(), 'b4m-cache');
      const stagedUnder = (value: string) => {
        vi.stubEnv(key, value);
        return setup().deps.importDir?.();
      };
      const fallback = stagedUnder('');
      expect(fallback && isAbsolute(fallback)).toBe(true);
      expect(stagedUnder('relative/cache')).toBe(fallback);
      expect(stagedUnder(absolute)).toBe(join(absolute, 'bike4mind-desktop', 'model-imports'));
      vi.unstubAllEnvs();
    }
  );

  it('tells the service when Settings saves or removes a server', () => {
    const { saved } = setup();
    saved('srv1');
    expect(service.serverChanged).toHaveBeenCalledWith('srv1');
  });

  it('closes leftover download grants at launch and records a started pull with where it lands', async () => {
    const pull = {
      key: 'qwen3:0.6b#q4_k_m',
      serverId: 'local',
      serverName: 'This computer',
      ref: 'qwen3:0.6b',
      label: 'Q4_K_M',
      sizeBytes: 522_653_767,
    };
    service.pulls.mockReturnValue([{ key: pull.key, phase: 'downloading' } as ModelPull]);
    service.storeLocation.mockResolvedValue({ path: '/models', source: 'runtime', freeBytes: 1 });
    const { deps } = setup();
    expect(ledger.revokeMatching).toHaveBeenCalledTimes(1);

    deps.onPullStarted?.(pull);
    await vi.waitFor(() => expect(ledger.use).toHaveBeenCalled());
    expect(service.storeLocation).toHaveBeenCalledWith('local');
    expect(ledger.grant).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: 'model-download',
        scope: expect.objectContaining({ kind: 'model-pull', value: pull.key, path: '/models', pathSource: 'runtime' }),
      })
    );
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
    machine: {
      memoryKind: 'cpu',
      totalMemoryBytes: 16 * 1024 ** 3,
      gpuMemoryBytes: null,
      gpuName: null,
      confidence: 'high',
    },
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
