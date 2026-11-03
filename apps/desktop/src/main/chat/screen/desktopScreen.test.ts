import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  getSources: vi.fn(),
  getMediaAccessStatus: vi.fn(),
}));

vi.mock('electron', () => ({
  desktopCapturer: { getSources: electron.getSources },
  systemPreferences: { getMediaAccessStatus: electron.getMediaAccessStatus },
}));

import { desktopScreenCapturer } from './desktopScreen';

const capturer = desktopScreenCapturer('Bike4Mind');

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('desktopScreenCapturer', () => {
  const realPlatform = process.platform;
  const realEnv = { session: process.env.XDG_SESSION_TYPE, display: process.env.WAYLAND_DISPLAY };

  beforeEach(() => {
    electron.getSources.mockReset();
    electron.getMediaAccessStatus.mockReset();
    delete process.env.XDG_SESSION_TYPE;
    delete process.env.WAYLAND_DISPLAY;
  });

  afterEach(() => {
    setPlatform(realPlatform);
    for (const [key, value] of [
      ['XDG_SESSION_TYPE', realEnv.session],
      ['WAYLAND_DISPLAY', realEnv.display],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('access', () => {
    it('maps the macOS Screen Recording status', () => {
      setPlatform('darwin');
      electron.getMediaAccessStatus.mockReturnValue('granted');
      expect(capturer.access()).toEqual({ state: 'granted' });
      electron.getMediaAccessStatus.mockReturnValue('not-determined');
      expect(capturer.access()).toEqual({ state: 'not-determined' });
    });

    it.each(['denied', 'restricted'])('refuses a %s macOS status with settings guidance', status => {
      setPlatform('darwin');
      electron.getMediaAccessStatus.mockReturnValue(status);
      expect(capturer.access()).toMatchObject({ state: 'denied', message: expect.stringContaining('System Settings') });
    });

    it('is unsupported under Wayland and granted under X11 or Windows', () => {
      setPlatform('linux');
      process.env.XDG_SESSION_TYPE = 'wayland';
      expect(capturer.access().state).toBe('unsupported');
      delete process.env.XDG_SESSION_TYPE;
      process.env.WAYLAND_DISPLAY = 'wayland-0';
      expect(capturer.access().state).toBe('unsupported');
      delete process.env.WAYLAND_DISPLAY;
      expect(capturer.access()).toEqual({ state: 'granted' });
      setPlatform('win32');
      expect(capturer.access()).toEqual({ state: 'granted' });
    });
  });

  describe('list', () => {
    it('asks for no thumbnails and maps ids to kinds', async () => {
      electron.getSources.mockResolvedValue([
        { id: 'screen:1:0', name: 'Entire Screen' },
        { id: 'window:42:0', name: 'Notes' },
      ]);
      await expect(capturer.list()).resolves.toEqual([
        { id: 'screen:1:0', kind: 'screen', name: 'Entire Screen' },
        { id: 'window:42:0', kind: 'window', name: 'Notes' },
      ]);
      expect(electron.getSources).toHaveBeenCalledWith({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
    });
  });

  describe('capture', () => {
    const thumbnail = (empty: boolean) => ({ isEmpty: () => empty, toPNG: () => Buffer.from('png') });

    it('asks only for the id type and returns that source as PNG', async () => {
      electron.getSources.mockResolvedValue([
        { id: 'window:1:0', thumbnail: thumbnail(false) },
        { id: 'window:2:0', thumbnail: thumbnail(false) },
      ]);
      await expect(capturer.capture('window:2:0', 1568)).resolves.toEqual(Buffer.from('png'));
      expect(electron.getSources).toHaveBeenCalledWith({
        types: ['window'],
        thumbnailSize: { width: 1568, height: 1568 },
      });

      electron.getSources.mockResolvedValue([{ id: 'screen:1:0', thumbnail: thumbnail(false) }]);
      await capturer.capture('screen:1:0', 1568);
      expect(electron.getSources).toHaveBeenLastCalledWith(expect.objectContaining({ types: ['screen'] }));
    });

    it('returns null for a missing source or an empty thumbnail', async () => {
      electron.getSources.mockResolvedValue([{ id: 'window:1:0', thumbnail: thumbnail(true) }]);
      await expect(capturer.capture('window:1:0', 1568)).resolves.toBeNull();
      await expect(capturer.capture('window:9:0', 1568)).resolves.toBeNull();
    });
  });
});
