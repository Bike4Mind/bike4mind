import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';
import { devLog } from './devlog/DevLogSink';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => unknown>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler),
  },
}));

const { registerRendererErrorLog } = await import('./rendererErrors');

describe('registerRendererErrorLog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    devLog.clear();
  });

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

  it('also keeps an errors record, with no window attached', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    send({ message: 'boom', stack: 'Error: boom', componentStack: '\n at X', route: '#/settings' });
    const { records } = devLog.snapshot();
    expect(records).toHaveLength(1);
    expect(records[0].tags).toEqual(['renderer', 'errors']);
    expect(records[0].message).toBe('boom');
    expect(records[0].fields).toEqual({ source: 'renderer', kind: 'render', route: '#/settings' });
  });

  it('keeps no record for a malformed report', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    send({ message: 42 });
    expect(devLog.snapshot().records).toHaveLength(0);
  });
});
