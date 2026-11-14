import { afterEach, describe, expect, it, vi } from 'vitest';

const quitAndInstall = vi.fn();

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', getPath: () => '/tmp' },
  ipcMain: { handle: vi.fn() },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    setFeedURL: vi.fn(),
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall,
  },
}));

vi.mock('../windows', () => ({ appWindows: () => [] }));

describe('registerUpdates install', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    quitAndInstall.mockClear();
  });

  it('installs silently and relaunches so Windows skips the setup wizard', async () => {
    vi.stubEnv('B4M_UPDATE_FEED_URL', 'https://example.com/releases/latest/download/');
    const { registerUpdates } = await import('./index');
    const { service, dispose } = registerUpdates({
      busy: () => ({ replying: 0, awaitingApproval: 0, background: 0 }),
      prepareQuit: async () => {},
    });
    service.apply({ type: 'downloaded', version: '9.9.9' });

    await service.install(true);
    dispose();

    expect(quitAndInstall).toHaveBeenCalledWith(true, true);
  });
});
