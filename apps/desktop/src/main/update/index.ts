import { app, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UpdateBusyReport, UpdateState } from '@shared/update';
import { resolveFeedUrl } from './feed';
import { UpdateService, type UpdaterPort } from './UpdateService';
import { appWindows } from '../windows';

/**
 * Baked in at build time; see feed.ts for why it cannot live in this repo. The expression is
 * substituted by electron.vite.config.ts, so a packaged app - which inherits no shell
 * environment - still has it.
 */
const CONFIGURED_FEED = process.env.B4M_UPDATE_FEED_URL;

/**
 * How long after launch the first check waits.
 *
 * Long enough to be behind everything the user is actually waiting for: the window painting,
 * the auth round-trip, the model catalog. An update check that competes with those makes the
 * app feel slower to start in exchange for news that is never urgent.
 */
const FIRST_CHECK_DELAY_MS = 15_000;

/**
 * And how often after that.
 *
 * Six hours because this app is left running for days - the background registry exists because
 * a dev server survived three of them - so "on launch" alone would mean a machine that never
 * reboots never hears about a release. Six hours is also well below the rate at which anyone
 * publishes one, so it is not a poll worth tuning.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

export interface RegisteredUpdates {
  service: UpdateService;
  /** Stops the scheduled checks. Called on the way out so no timer outlives the app. */
  dispose(): void;
}

export interface UpdateDeps {
  busy: () => UpdateBusyReport;
  prepareQuit: () => Promise<void>;
}

/**
 * Wire electron-updater to the state machine, expose it over IPC, and schedule the checks.
 *
 * The updater is only constructed when this is a packaged build WITH a feed. In dev, or in a
 * fork that configured nothing, the service is created with a null port: every operation
 * no-ops, the state stays 'unsupported', and the Customize row still shows the version. That is
 * deliberate - the alternative is electron-updater throwing "application is not packed" on
 * every launch of every dev run.
 */
export function registerUpdates(deps: UpdateDeps): RegisteredUpdates {
  const feedUrl = resolveFeedUrl(CONFIGURED_FEED);
  const enabled = app.isPackaged && feedUrl !== null;

  const send = (state: UpdateState) => {
    for (const window of appWindows()) {
      window.webContents.send(IPC_CHANNELS.updateStateChanged, state);
    }
  };

  let port: UpdaterPort | null = null;
  if (enabled && feedUrl) {
    // Downloading is the user's choice, not a side effect of launching: it is their bandwidth
    // and their disk. And nothing installs itself on quit - an update applied because the user
    // closed the window is an update they never agreed to.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = VERBOSE ? console : null;
    autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });

    port = {
      check: async () => {
        await autoUpdater.checkForUpdates();
      },
      download: async () => {
        await autoUpdater.downloadUpdate();
      },
      install: () => autoUpdater.quitAndInstall(),
    };
  }

  const service = new UpdateService({
    currentVersion: app.getVersion(),
    updater: port,
    busy: deps.busy,
    prepareQuit: deps.prepareQuit,
    onChanged: send,
  });

  if (enabled) {
    autoUpdater.on('update-available', info => {
      service.apply({ type: 'available', version: info.version, at: Date.now() });
    });
    autoUpdater.on('update-not-available', () => {
      service.apply({ type: 'up-to-date', at: Date.now() });
    });
    autoUpdater.on('download-progress', progress => {
      service.apply({ type: 'progress', percent: progress.percent });
    });
    autoUpdater.on('update-downloaded', info => {
      service.apply({ type: 'downloaded', version: info.version });
    });
    // No network, a feed that 404s, a manifest that does not parse, and a signature that does
    // not verify all arrive here. None of them is shown: the user did not ask about updates,
    // and a startup that nags about a release server is a worse app than one that is quiet.
    // Both are applied because only one of them can bite: the reducer ignores 'download-failed'
    // unless a download is running, and ignores 'unreachable' unless nothing is on offer. Which
    // one this error was is exactly what electron-updater does not tell us.
    autoUpdater.on('error', () => {
      service.apply({ type: 'download-failed' });
      service.apply({ type: 'unreachable' });
    });
  }

  ipcMain.handle(IPC_CHANNELS.updateGetState, () => service.snapshot());
  ipcMain.handle(IPC_CHANNELS.updateCheck, () => service.check());
  ipcMain.handle(IPC_CHANNELS.updateDownload, () => service.download());
  // Coerced rather than trusted: this is the one door to quitting the app, and anything that is
  // not an explicit `true` has to land as "ask the user first".
  ipcMain.handle(IPC_CHANNELS.updateInstall, (_event, force: unknown) => service.install(force === true));

  const timers: NodeJS.Timeout[] = [];
  if (enabled) {
    timers.push(setTimeout(() => void service.check(), FIRST_CHECK_DELAY_MS));
    timers.push(setInterval(() => void service.check(), CHECK_INTERVAL_MS));
    // Neither timer is a reason for the process to stay alive.
    for (const timer of timers) timer.unref?.();
  }

  return {
    service,
    dispose: () => {
      for (const timer of timers) clearTimeout(timer as NodeJS.Timeout);
      for (const timer of timers) clearInterval(timer as NodeJS.Timeout);
      timers.length = 0;
    },
  };
}

export { UpdateService } from './UpdateService';
