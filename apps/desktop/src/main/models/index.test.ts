import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { AUTO_LOCAL_CONTEXT } from '@shared/localContextSetting';
import type { HfTokenResult } from '@shared/models';
import { ModelHubService } from './ModelHubService';
import { registerModels } from './index';

type Handler = (event: { sender: { id: number } }, value?: unknown) => unknown;
const { handlers, origin, other } = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  origin: { webContents: { id: 1, send: vi.fn() } },
  other: { webContents: { id: 2, send: vi.fn() } },
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/unused/test-user-data' },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    },
  },
  safeStorage: {},
}));
vi.mock('../windows', () => ({ appWindows: () => [origin, other] }));

beforeEach(() => {
  handlers.clear();
  origin.webContents.send.mockClear();
  other.webContents.send.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
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
