import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { describe, expect, it, vi } from 'vitest';
import { machineView } from '../models/fit';
import { registerModelServersIpc, specsInput } from './ipc';

function register(probed?: Parameters<typeof registerModelServersIpc>[2]) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipc = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, listener),
  } as unknown as Pick<IpcMain, 'handle'>;
  const registry = {
    views: vi.fn(async () => []),
    probe: vi.fn(),
    add: vi.fn(),
    update: vi.fn(async () => []),
    remove: vi.fn(),
    check: vi.fn(),
    startServer: vi.fn(async () => []),
    stopServer: vi.fn(async () => []),
    restartServer: vi.fn(async () => []),
  } as unknown as Parameters<typeof registerModelServersIpc>[1];
  registerModelServersIpc(ipc, registry, probed);
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  return { registry, invoke };
}

describe('specsInput', () => {
  it('keeps numbers, blanks the rest, and reads anything but true as not unified', () => {
    expect(specsInput({ ramGiB: 64, gpuMemoryGiB: '24', bandwidthGBps: 900, unified: 'yes' })).toEqual({
      ramGiB: 64,
      gpuMemoryGiB: null,
      bandwidthGBps: 900,
      unified: false,
    });
    expect(specsInput(undefined)).toBeUndefined();
    expect(specsInput(null)).toBeNull();
    expect(specsInput('64')).toBeNull();
  });

  it('keeps a quantized KV cache type, which a remote Ollama keeps under Hardware, and drops any other', () => {
    const blank = { ramGiB: null, gpuMemoryGiB: null, bandwidthGBps: null, unified: false };
    expect(specsInput({ ...blank, kvCacheType: 'q4_0' })).toEqual({ ...blank, kvCacheType: 'q4_0' });
    expect(specsInput({ ...blank, kvCacheType: 'f16' })).toEqual(blank);
    expect(specsInput({ ...blank, kvCacheType: 'q8_0; rm' })).toEqual(blank);
  });
});

describe('registerModelServersIpc check', () => {
  it('marks a check the renderer asks for as a user check, so Desktop looks for Ollama again', async () => {
    const { registry, invoke } = register();
    await invoke(IPC_CHANNELS.modelServersCheck, 'local');
    await invoke(IPC_CHANNELS.modelServersCheck);
    expect(registry.check).toHaveBeenNthCalledWith(1, 'local', { lookAgain: true });
    expect(registry.check).toHaveBeenNthCalledWith(2, undefined, { lookAgain: true });
  });
});

describe('registerModelServersIpc launch', () => {
  it('passes launch settings through their shape and drops anything else', async () => {
    const { registry, invoke } = register();
    await invoke(IPC_CHANNELS.modelServersUpdate, 'local', {
      launch: { kvCacheType: 'q8_0', flashAttention: 'on', modelsDir: ' /m ', extra: 'x' },
    });
    await invoke(IPC_CHANNELS.modelServersUpdate, 'local', { launch: { kvCacheType: 'q8_0; rm', flashAttention: 1 } });
    expect(registry.update).toHaveBeenNthCalledWith(1, 'local', {
      launch: { kvCacheType: 'q8_0', flashAttention: 'on', modelsDir: '/m' },
    });
    expect(registry.update).toHaveBeenNthCalledWith(2, 'local', { launch: {} });
  });

  it('runs start, stop and restart, and refuses any other action', async () => {
    const { registry, invoke } = register();
    expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'start')).toEqual({ ok: true, servers: [] });
    await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'stop');
    await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'restart');
    expect(registry.startServer).toHaveBeenCalledWith('abc');
    expect(registry.stopServer).toHaveBeenCalledWith('abc');
    expect(registry.restartServer).toHaveBeenCalledWith('abc');
    expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'kill')).toEqual({
      ok: false,
      error: 'Unknown server action.',
    });
  });

  it('answers a failed start with its message', async () => {
    const { registry, invoke } = register();
    vi.mocked(registry.startServer).mockRejectedValueOnce(new Error('port 11500 is in use'));
    expect(await invoke(IPC_CHANNELS.modelServersLaunch, 'abc', 'start')).toEqual({
      ok: false,
      error: 'port 11500 is in use',
    });
  });

  it('passes a launch add through only when asked', async () => {
    const { registry, invoke } = register();
    await invoke(IPC_CHANNELS.modelServersAdd, { address: 'http://127.0.0.1:8090', name: 'r', launch: true });
    await invoke(IPC_CHANNELS.modelServersAdd, { address: 'http://127.0.0.1:8090', name: 'r', launch: 'yes' });
    expect(registry.add).toHaveBeenNthCalledWith(1, expect.objectContaining({ launch: true }));
    expect(registry.add).toHaveBeenNthCalledWith(2, expect.not.objectContaining({ launch: expect.anything() }));
  });
});

describe('registerModelServersIpc transport', () => {
  it('passes an SSH destination through as ssh and anything else as http', async () => {
    const { registry, invoke } = register();
    await invoke(IPC_CHANNELS.modelServersProbe, { address: 'me@gpu', transport: 'ssh' });
    await invoke(IPC_CHANNELS.modelServersProbe, { address: 'gpu:11434', transport: 'telnet' });
    await invoke(IPC_CHANNELS.modelServersAdd, { address: 'me@gpu', transport: 'ssh', name: 'gpu' });
    expect(registry.probe).toHaveBeenNthCalledWith(1, expect.objectContaining({ address: 'me@gpu', transport: 'ssh' }));
    expect(registry.probe).toHaveBeenNthCalledWith(2, expect.objectContaining({ transport: 'http' }));
    expect(registry.add).toHaveBeenCalledWith(expect.objectContaining({ address: 'me@gpu', transport: 'ssh' }));
  });
});

describe('registerModelServersIpc hardware', () => {
  it('passes entered specs to the registry and leaves them out when not sent', async () => {
    const { registry, invoke } = register();
    await invoke(IPC_CHANNELS.modelServersUpdate, 'gpu', {
      specs: { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: true },
    });
    await invoke(IPC_CHANNELS.modelServersUpdate, 'gpu', { name: 'gpu box' });
    expect(registry.update).toHaveBeenNthCalledWith(1, 'gpu', {
      specs: { ramGiB: 64, gpuMemoryGiB: null, bandwidthGBps: null, unified: true },
    });
    expect(registry.update).toHaveBeenNthCalledWith(2, 'gpu', { name: 'gpu box' });
  });

  it("answers this computer's probed hardware, and null when the probe fails", async () => {
    const machine = machineView({
      platform: 'linux',
      arch: 'x64',
      memoryKind: 'cpu',
      totalMemoryBytes: 1,
      gpuMemoryBytes: null,
      gpuName: null,
      gpuCount: 0,
      chip: null,
      diskFreeBytes: null,
      confidence: 'high',
    });
    expect(await register(async () => machine).invoke(IPC_CHANNELS.modelServersProbedHardware)).toEqual(machine);
    expect(
      await register(() => Promise.reject(new Error('no probe'))).invoke(IPC_CHANNELS.modelServersProbedHardware)
    ).toBeNull();
  });
});
