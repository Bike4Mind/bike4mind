import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@shared/ipc';

const { handle, nativeTheme, windows } = vi.hoisted(() => ({
  handle: vi.fn(),
  nativeTheme: { themeSource: 'system' },
  windows: [
    { webContents: {}, setBackgroundColor: vi.fn() },
    { webContents: {}, setBackgroundColor: vi.fn() },
  ],
}));
vi.mock('electron', () => ({ ipcMain: { handle }, nativeTheme }));
vi.mock('./windows', () => ({ appWindows: () => windows }));
import { registerWindowTheme } from './windowTheme';

describe('native window theme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nativeTheme.themeSource = 'system';
    registerWindowTheme();
  });

  it.each(['light', 'dark', 'system'])('applies %s appearance and background to app windows', mode => {
    expect(handle).toHaveBeenCalledWith(IPC_CHANNELS.setTheme, expect.any(Function));
    handle.mock.calls[0][1]({ sender: windows[0].webContents }, mode, '#123abc');
    expect(nativeTheme.themeSource).toBe(mode);
    for (const window of windows) expect(window.setBackgroundColor).toHaveBeenCalledWith('#123abc');
  });

  it.each([
    ['invalid', '#123abc'],
    ['dark', 'invalid'],
    ['light', null],
  ])('ignores invalid theme input %s / %s', (mode, color) => {
    handle.mock.calls[0][1]({ sender: windows[0].webContents }, mode, color);
    expect(nativeTheme.themeSource).toBe('system');
    for (const window of windows) expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('ignores messages from non-app windows', () => {
    handle.mock.calls[0][1]({ sender: {} }, 'dark', '#123abc');
    expect(nativeTheme.themeSource).toBe('system');
    for (const window of windows) expect(window.setBackgroundColor).not.toHaveBeenCalled();
  });
});
