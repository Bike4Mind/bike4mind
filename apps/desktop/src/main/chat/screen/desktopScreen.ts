import { desktopCapturer, systemPreferences } from 'electron';
import type { ScreenAccess, ScreenCapturer, ScreenSource } from '../tools/types';

const MAC_SETTINGS = 'System Settings > Privacy & Security > Screen & System Audio Recording';

function macAccess(appName: string): ScreenAccess {
  const status = systemPreferences.getMediaAccessStatus('screen');
  if (status === 'granted') return { state: 'granted' };
  if (status === 'not-determined') return { state: 'not-determined' };
  return {
    state: 'denied',
    message:
      `Screen Recording is not allowed for ${appName}, so other apps' windows cannot be captured. Ask the user to ` +
      `turn it on for ${appName} in ${MAC_SETTINGS}, then quit and reopen ${appName}. Do not try to change the setting yourself.`,
  };
}

/**
 * desktopCapturer under a Wayland session only works through the portal's own picker, which a
 * tool call has no user at the keyboard to answer.
 */
function isWayland(): boolean {
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY;
}

/** Electron's desktopCapturer. Nothing runs until a tool calls it: no per-turn or startup cost. */
export function desktopScreenCapturer(appName: string): ScreenCapturer {
  return {
    access() {
      if (process.platform === 'darwin') return macAccess(appName);
      if (process.platform === 'linux' && isWayland()) {
        return {
          state: 'unsupported',
          message:
            'Window capture is not supported in a Wayland session. Ask the user for a screenshot, or to run the app under X11.',
        };
      }
      return { state: 'granted' };
    },
    async list() {
      // A zero thumbnail size skips capturing every window just to name them.
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 0, height: 0 },
      });
      return sources.map((source): ScreenSource => ({
        id: source.id,
        kind: source.id.startsWith('screen:') ? 'screen' : 'window',
        name: source.name,
      }));
    },
    async capture(id, maxEdge) {
      // Thumbnails are taken for every source of the requested type, so only that type is asked for.
      const sources = await desktopCapturer.getSources({
        types: [id.startsWith('screen:') ? 'screen' : 'window'],
        thumbnailSize: { width: maxEdge, height: maxEdge },
      });
      const thumbnail = sources.find(source => source.id === id)?.thumbnail;
      if (!thumbnail || thumbnail.isEmpty()) return null;
      return thumbnail.toPNG();
    },
  };
}
