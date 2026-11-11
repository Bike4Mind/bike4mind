import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { registerLocalDataExportIpc } from './localDataExportIpc';
import { writeLocalDataExport } from './localDataExport';

vi.mock('./localDataExport', () => ({ writeLocalDataExport: vi.fn(async () => '/tmp/export') }));

describe('local data export IPC', () => {
  const setup = () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const deps = { pickFolder: vi.fn(async () => null as string | null) };
    registerLocalDataExportIpc(
      {
        handle: (channel: string, handler: (...args: never[]) => unknown) =>
          void handlers.set(channel, handler as never),
      },
      deps as never
    );
    return { deps, invoke: () => handlers.get(IPC_CHANNELS.chatExportLocalData)!({ sender: {} }) };
  };

  it('does not write when the picker is cancelled', async () => {
    const { invoke } = setup();
    await expect(invoke()).resolves.toEqual({ saved: false });
    expect(writeLocalDataExport).not.toHaveBeenCalled();
  });

  it('uses only the native picker path', async () => {
    const { deps, invoke } = setup();
    deps.pickFolder.mockResolvedValueOnce('/tmp/chosen');
    await expect(invoke()).resolves.toEqual({ saved: true, path: '/tmp/export' });
    expect(writeLocalDataExport).toHaveBeenCalledWith('/tmp/chosen', deps);
  });
});
