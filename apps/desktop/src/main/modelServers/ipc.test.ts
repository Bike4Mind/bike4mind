import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { describe, expect, it, vi } from 'vitest';
import { machineView } from '../models/fit';
import { registerModelServersIpc, specsInput } from './ipc';
import type { ModelServerRegistry } from './ModelServerRegistry';

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
  } as unknown as Pick<ModelServerRegistry, 'views' | 'probe' | 'add' | 'update' | 'remove' | 'check'>;
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
