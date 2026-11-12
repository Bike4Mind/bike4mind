import { join } from 'node:path';
import { app, nativeImage, type NativeImage } from 'electron';
import type { AttentionOpenEvent } from '@shared/attention';
import type { ChatSessionStatusEvent, ChatStreamEvent } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';
import { pickRoom, type WatchOverall, type WatchPreferences, type WatchPreferencesPatch } from '@shared/watch';
import trayDone from '../../../build/tray/trayDoneTemplate.png?asset';
import trayDone2x from '../../../build/tray/trayDoneTemplate@2x.png?asset';
import trayIdle from '../../../build/tray/trayIdleTemplate.png?asset';
import trayIdle2x from '../../../build/tray/trayIdleTemplate@2x.png?asset';
import trayNeedsYou from '../../../build/tray/trayNeedsYouTemplate.png?asset';
import trayNeedsYou2x from '../../../build/tray/trayNeedsYouTemplate@2x.png?asset';
import trayWorking from '../../../build/tray/trayWorkingTemplate.png?asset';
import trayWorking2x from '../../../build/tray/trayWorkingTemplate@2x.png?asset';
import { appWindows } from '../windows';
import { registerWatchIpc } from './ipc';
import { createMiniWindowController } from './miniWindow';
import { createTrayController, type TrayController } from './tray';
import { trayPresentation } from './trayPresentation';
import { WatchPreferencesStore } from './WatchPreferencesStore';
import { WatchService, type WatchSources } from './WatchService';

const TEMPLATE_ICONS: Record<WatchOverall, readonly [string, string]> = {
  idle: [trayIdle, trayIdle2x],
  working: [trayWorking, trayWorking2x],
  'needs-you': [trayNeedsYou, trayNeedsYou2x],
  done: [trayDone, trayDone2x],
};

/**
 * macOS gets the lantern templates, tinted by the system for a light or dark menu bar. Bundled
 * assets lose the @2x naming convention, so both scales are added to one image by hand. Elsewhere
 * template images are not a thing, so every state shows the app icon and the tooltip carries it.
 */
function trayImages(appIcon: string): Record<WatchOverall, NativeImage> {
  const images = {} as Record<WatchOverall, NativeImage>;
  for (const [state, [standard, retina]] of Object.entries(TEMPLATE_ICONS) as Array<
    [WatchOverall, readonly [string, string]]
  >) {
    if (process.platform !== 'darwin') {
      images[state] = nativeImage.createFromPath(appIcon).resize({ width: 16, height: 16 });
      continue;
    }
    const image = nativeImage.createFromPath(standard);
    image.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(retina).toPNG() });
    image.setTemplateImage(true);
    images[state] = image;
  }
  return images;
}

export type WatchDeps = {
  sources: Omit<WatchSources, 'warn'>;
  /** Raise the app window on a session's stage (attention's openSession). */
  openSession(open: AttentionOpenEvent): void;
  /** Bring up the app window with no particular session. */
  showApp(): void;
  appIcon: string;
  /** Past the quit confirmation (main/index.ts quitState); a cancelled quit is not quitting. */
  isQuitting(): boolean;
  rendererDevUrl?: string;
};

export type Watch = {
  observeStatus(event: ChatSessionStatusEvent): void;
  observeStream(event: ChatStreamEvent): void;
  scopeChanged(): void;
  closeMini(): void;
  /** Loads preferences, seeds the service, and reopens the mini Tavern if it was open at quit. */
  start(): Promise<void>;
};

/**
 * The hands-off watcher's surfaces: the menu-bar item and the mini Tavern window, both fed by one
 * WatchService. See WatchService for where its data comes from.
 */
export function registerWatch(deps: WatchDeps): Watch {
  const preferences = new WatchPreferencesStore(join(app.getPath('userData'), 'watch-preferences.json'));
  const service = new WatchService({ ...deps.sources, warn: message => console.warn(message) });
  const mini = createMiniWindowController({
    preferences,
    isQuitting: deps.isQuitting,
    ...(deps.rendererDevUrl ? { rendererDevUrl: deps.rendererDevUrl } : {}),
  });
  let tray: TrayController | null = null;
  let images: Record<WatchOverall, NativeImage> | null = null;
  // Shown once the user has orchestrated at all, then kept for the run, so it never flickers.
  let everOrchestrated = false;

  const openTavern = () => {
    const room = pickRoom(service.snapshot(), null).rootId;
    if (room) deps.openSession({ sessionId: room, rootId: room });
    else deps.showApp();
  };

  const setPreferences = async (patch: WatchPreferencesPatch): Promise<WatchPreferences> => {
    const next = await preferences.update(patch);
    syncTray();
    for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.watchPreferences, next);
    return next;
  };

  function syncTray(): void {
    if (!preferences.current().showInMenuBar || !everOrchestrated || deps.isQuitting()) {
      tray?.destroy();
      tray = null;
      return;
    }
    images ??= trayImages(deps.appIcon);
    tray ??= createTrayController(images, {
      respond: (approvalId, decision) => void service.respond(approvalId, decision),
      focus: open => deps.openSession(open),
      action: action => {
        if (action === 'open-tavern') openTavern();
        else if (action === 'toggle-mini') mini.toggle();
        else void setPreferences({ showInMenuBar: false });
      },
      menuOpened: () => service.acknowledge(),
    });
    tray.render(trayPresentation(service.snapshot(), mini.isOpen()));
  }

  service.onChange(snapshot => {
    if (snapshot.orchestrations.length > 0) everOrchestrated = true;
    mini.push(snapshot);
    syncTray();
  });
  mini.onVisibilityChanged(() => syncTray());

  // The user looking at the app is the user having seen that work finished.
  app.on('browser-window-focus', (_event, window) => {
    if (appWindows().includes(window)) service.acknowledge();
  });
  // Every quit pass, including one the user then cancels; syncTray brings it back if so.
  app.on('before-quit', () => {
    tray?.destroy();
    tray = null;
    if (!deps.isQuitting()) setImmediate(syncTray);
  });

  registerWatchIpc({
    snapshot: () => service.snapshot(),
    respond: (approvalId, decision) => service.respond(approvalId, decision),
    openSession: deps.openSession,
    isMiniWindow: sender => mini.owns(sender),
    closeMini: () => mini.hide(),
    preferences: () => preferences.current(),
    setPreferences,
  });

  return {
    observeStatus: event => service.observeStatus(event),
    observeStream: event => service.observeStream(event),
    scopeChanged: () => service.scopeChanged(),
    closeMini: () => mini.hide(),
    start: async () => {
      await preferences.load();
      service.start();
      await service.settled();
      if (preferences.current().miniOpen) mini.show();
    },
  };
}
