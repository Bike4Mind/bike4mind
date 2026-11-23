import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler),
  },
}));

const { registerRendererErrorLog } = await import('./rendererErrors');

describe('registerRendererErrorLog', () => {
  afterEach(() => vi.restoreAllMocks());

  const send = (payload: unknown) => {
    registerRendererErrorLog();
    handlers.get(IPC_CHANNELS.rendererReportError)?.({}, payload);
  };

  it('writes a render error to the main log', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    send({ message: 'boom', stack: 'Error: boom\n    at Sidebar', route: '#/settings' });
    expect(error).toHaveBeenCalledWith('RENDERER: render error on #/settings: boom', '\nError: boom\n    at Sidebar');
  });

  it('drops a malformed report', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    send({ message: 42 });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('RENDERER: dropped a malformed error report');
  });
});
