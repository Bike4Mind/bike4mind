import type { HubModelDetail } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelServerManagement } from '@shared/modelServers';
import { describe, expect, it, vi } from 'vitest';
import { registerModelsIpc } from './ipc';
import { ModelHubService, type ModelRuntimePort } from './ModelHubService';

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function runtime(): ModelRuntimePort & { pull: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return {
    baseUrl: 'http://192.168.1.20:11434',
    health: async () => ({ ok: true, version: '0.12.0', error: null }),
    list: async () => [],
    loaded: async () => [],
    pull: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

function setup(management: ModelServerManagement) {
  const local = runtime();
  const remote = runtime();
  const getModel = vi.fn(async (): Promise<HubModelDetail> => {
    throw new Error('the hub must not be asked for a refused pull');
  });
  const service = new ModelHubService({
    runtime: local,
    server: id => (id === 'gpu' ? { name: 'gpu box', management, runtime: remote } : null),
    hub: {
      endpoint: 'https://huggingface.co',
      search: async () => ({ models: [], nextCursor: null }),
      getModel,
      verifyOllamaRef: async () => null,
    },
    onPullsChanged: () => undefined,
    onInstalledChanged: () => undefined,
  });
  const handlers = new Map<string, Handler>();
  registerModelsIpc(
    {
      handle: (channel: string, listener: (...args: never[]) => unknown) =>
        void handlers.set(channel, listener as never),
    },
    service
  );
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { invoke, local, remote, getModel };
}

const pullRequest = {
  repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
  buildId: 'q4',
  revision: 'b'.repeat(40),
  sizeBytes: 1_000,
  acceptLicense: true,
  confirmAccess: true,
  serverId: 'gpu',
};

describe('registerModelsIpc', () => {
  it.each(['chat-only', 'unsupported'] as const)(
    'refuses a pull and a removal for a %s server before anything reaches it',
    async management => {
      const { invoke, local, remote, getModel } = setup(management);

      expect(await invoke(IPC_CHANNELS.modelsPull, pullRequest)).toMatchObject({
        ok: false,
        error: { kind: 'not-allowed', message: expect.stringContaining('gpu box') },
        listed: false,
      });
      expect(await invoke(IPC_CHANNELS.modelsRemove, 'qwen2.5:0.5b', 'gpu')).toMatchObject({
        ok: false,
        error: { kind: 'not-allowed' },
      });
      expect(getModel).not.toHaveBeenCalled();
      expect(remote.pull).not.toHaveBeenCalled();
      expect(remote.remove).not.toHaveBeenCalled();
      expect(local.remove).not.toHaveBeenCalled();
      expect(await invoke(IPC_CHANNELS.modelsListPulls)).toEqual([]);
    }
  );

  it('sends a removal to the named server, and to this computer without one', async () => {
    const { invoke, local, remote } = setup('allowed');
    expect(await invoke(IPC_CHANNELS.modelsRemove, 'qwen2.5:0.5b', 'gpu')).toEqual({ ok: true });
    expect(remote.remove).toHaveBeenCalledWith('qwen2.5:0.5b');
    expect(await invoke(IPC_CHANNELS.modelsRemove, 'llama3', undefined)).toEqual({ ok: true });
    expect(local.remove).toHaveBeenCalledWith('llama3');
  });

  it.each([42, null, '', { id: 'gpu' }])('refuses a server id of %j instead of acting on this computer', async id => {
    const { invoke, local, remote } = setup('allowed');
    expect(await invoke(IPC_CHANNELS.modelsRemove, 'llama3', id)).toMatchObject({
      ok: false,
      error: { kind: 'invalid' },
    });
    expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, serverId: id })).toMatchObject({
      ok: false,
      error: { kind: 'invalid' },
      listed: false,
    });
    expect(await invoke(IPC_CHANNELS.modelsListInstalled, id)).toMatchObject({ ok: false, error: { kind: 'invalid' } });
    expect(await invoke(IPC_CHANNELS.modelsGetStatus, id)).toMatchObject({ reachable: false, serverId: '' });
    expect(local.remove).not.toHaveBeenCalled();
    expect(remote.remove).not.toHaveBeenCalled();
  });

  it.each(['gpu/Qwen/Qwen2.5-0.5B-Instruct-GGUF', 'Qwen', 'Qwen/a#b', '../x/y'])(
    'refuses a pull of repo %s, so it cannot reuse another pull key',
    async repo => {
      const { invoke, getModel } = setup('allowed');
      expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, repo, serverId: undefined })).toMatchObject({
        ok: false,
        error: { kind: 'invalid' },
      });
      expect(getModel).not.toHaveBeenCalled();
      expect(await invoke(IPC_CHANNELS.modelsListPulls)).toEqual([]);
    }
  );

  it('reports a server that is no longer saved', async () => {
    const { invoke } = setup('allowed');
    expect(await invoke(IPC_CHANNELS.modelsGetStatus, 'gone')).toMatchObject({ reachable: false, serverId: 'gone' });
    expect(await invoke(IPC_CHANNELS.modelsPull, { ...pullRequest, serverId: 'gone' })).toMatchObject({
      ok: false,
      error: { kind: 'not-found' },
    });
  });
});
