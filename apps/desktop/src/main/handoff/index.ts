import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { onAuthStateChanged, type AuthService } from '../auth';

const WEB_LANDING_PATH = '/notebooks';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The web app page for the signed-in environment, or null when there is none to open.
 *
 * The web app is served from the same origin as the API Desktop talks to, so the environment url
 * (production, staging, a preview or a custom server) is the origin to open. Plain http is allowed
 * only for a loopback dev server.
 */
export function webAppUrlFor(environmentUrl: string): string | null {
  let base: URL;
  try {
    base = new URL(environmentUrl);
  } catch {
    return null;
  }
  const secure = base.protocol === 'https:';
  const loopbackDev = base.protocol === 'http:' && LOOPBACK_HOSTS.has(base.hostname);
  if (!secure && !loopbackDev) return null;
  // Built from the origin alone, so a path, query or userinfo in the configured url never reaches the browser.
  return new URL(WEB_LANDING_PATH, base.origin).href;
}

// Earlier builds opened the web app in an embedded window whose storage partition
// (`persist:server-conversations-<hash>`) kept a web session's refresh cookie on disk.
const LEGACY_WEB_PARTITION_PREFIX = 'server-conversations-';

/** Deletes every web-window storage partition an earlier build left under `userDataDir`. */
export async function purgeLegacyWebPartitions(userDataDir: string): Promise<void> {
  const partitionsDir = join(userDataDir, 'Partitions');
  let names: string[];
  try {
    names = await readdir(partitionsDir);
  } catch {
    return;
  }
  const legacy = names.filter(name => name.toLowerCase().startsWith(LEGACY_WEB_PARTITION_PREFIX));
  await Promise.all(
    legacy.map(name =>
      rm(join(partitionsDir, name), { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(`handoff: could not remove a leftover web partition: ${err instanceof Error ? err.message : err}`);
      })
    )
  );
}

/**
 * "Open Bike4Mind web" hands the web app to the user's default browser. The browser keeps its own
 * web sign-in, so Desktop shares no session with it.
 */
export function registerSessionHandoff(auth: AuthService, userDataDir: string): void {
  void purgeLegacyWebPartitions(userDataDir);
  onAuthStateChanged(state => {
    if (state.status === 'signed-out') void purgeLegacyWebPartitions(userDataDir);
  });
  ipcMain.handle(IPC_CHANNELS.handoffOpenServerSessions, async () => {
    const state = auth.getState();
    if (state.status !== 'signed-in') return;
    const url = webAppUrlFor(state.environment.url);
    if (!url) {
      console.warn('handoff: the environment url cannot be opened in a browser');
      return;
    }
    await shell.openExternal(url);
  });
}
