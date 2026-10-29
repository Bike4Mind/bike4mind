import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { CuratedSourceView, HfTokenResult } from '@shared/models';
import { ModelHubService } from './ModelHubService';
import { registerModels } from './index';

type Handler = (event: { sender: { id: number } }, value?: unknown) => unknown;
const { handlers, origin, other, sourceView } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  sourceView: vi.fn(),
  origin: { webContents: { id: 1, send: vi.fn() } },
  other: { webContents: { id: 2, send: vi.fn() } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/unused/test-user-data', getVersion: () => '0.1.12', isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
  safeStorage: {},
}));
vi.mock('./curated/CuratedSource', () => ({
  CuratedSource: class {
    current = vi.fn();
    loaded = async () => {};
    checkIfDue = async () => {};
    view = sourceView;
  },
}));
vi.mock('../windows', () => ({ appWindows: () => [origin, other] }));

beforeEach(() => {
  vi.stubGlobal('__B4M_CURATED_DEV_KEYS__', false);
  sourceView.mockReset().mockReturnValue({
    origin: 'bundled',
    sequence: 1,
    check: 'idle',
    checkedAt: null,
    stale: false,
  } satisfies CuratedSourceView);
  handlers.clear();
  origin.webContents.send.mockClear();
  other.webContents.send.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Models credential IPC', () => {
  it.each([
    [IPC_CHANNELS.modelsSaveHfAccess, true],
    [IPC_CHANNELS.modelsClearHfAccess, false],
  ])('broadcasts only the successful status to other windows for %s', async (channel, set) => {
    const result: HfTokenResult = { ok: true, status: { set, persisted: true } };
    const save = vi.spyOn(ModelHubService.prototype, 'setToken').mockResolvedValue(result);
    vi.spyOn(ModelHubService.prototype, 'clearToken').mockResolvedValue(result);
    registerModels({ localContext: async () => AUTO_LOCAL_CONTEXT });
    const response = await handlers.get(channel)?.({ sender: { id: 1 } }, 'hf_secret_never_broadcast');
    expect(response).toEqual(result);
    expect(origin.webContents.send).not.toHaveBeenCalled();
    expect(other.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC_CHANNELS.modelsHfAccessChanged, result.status);
    expect(JSON.stringify(other.webContents.send.mock.calls)).not.toContain('hf_secret_never_broadcast');
    if (set) expect(save).toHaveBeenCalledWith('hf_secret_never_broadcast');
  });

  it.each([IPC_CHANNELS.modelsSaveHfAccess, IPC_CHANNELS.modelsClearHfAccess])(
    'does not broadcast a failed mutation for %s',
    async channel => {
      const result: HfTokenResult = { ok: false, error: { kind: 'failed', message: 'Could not write.' } };
      vi.spyOn(ModelHubService.prototype, 'setToken').mockResolvedValue(result);
      vi.spyOn(ModelHubService.prototype, 'clearToken').mockResolvedValue(result);
      registerModels({ localContext: async () => AUTO_LOCAL_CONTEXT });
      expect(await handlers.get(channel)?.({ sender: { id: 1 } }, 'hf_secret_never_broadcast')).toEqual(result);
      expect(origin.webContents.send).not.toHaveBeenCalled();
      expect(other.webContents.send).not.toHaveBeenCalled();
    }
  );
});

describe('Models curated IPC', () => {
  it('keeps source metadata with the manifest snapshot while model probes are pending', async () => {
    const bundledView = sourceView();
    let finish: (() => void) | undefined;
    const curated = vi.spyOn(ModelHubService.prototype, 'curated').mockImplementation(async () => {
      await new Promise<void>(resolve => {
        finish = resolve;
      });
      return {
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
    });
    registerModels({ localContext: async () => AUTO_LOCAL_CONTEXT });
    const response = handlers.get(IPC_CHANNELS.modelsListCurated)?.({ sender: { id: 1 } });
    await vi.waitFor(() => expect(curated).toHaveBeenCalledOnce());
    sourceView.mockReturnValue({ ...bundledView, origin: 'updated', sequence: 2, check: 'updated' });
    if (!finish) throw new Error('The curated probe never started');
    finish();
    await expect(response).resolves.toMatchObject({ source: bundledView });
  });
});
