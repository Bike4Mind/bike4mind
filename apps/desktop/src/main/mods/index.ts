import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import { skinAssetUrl, type SkinSummary, type SkinTokens } from '@shared/mods';
import { appWindows } from '../windows';
import { loadSkins, type LoadedSkin, type SkinLoadResult } from './skinFolder';
import { registerSkinProtocol } from './skinProtocol';

// A copy into the folder fires a burst of events; one rescan after it settles is enough.
const RESCAN_DEBOUNCE_MS = 300;

/**
 * Tier 1 mods: data-only skins read from userData/mods/<id>/. Main validates every folder
 * (skinFolder.ts), serves only the files a valid skin references (skinProtocol.ts), and gives the
 * renderer validated tokens with asset URLs. The folder is watched, and the renderer's Refresh rescans.
 */
export function registerSkins(): void {
  const modsRoot = join(app.getPath('userData'), 'mods');
  let loaded = new Map<string, LoadedSkin>();
  let latest: SkinSummary[] = [];

  registerSkinProtocol(() => loaded);

  const scan = async (): Promise<SkinSummary[]> => {
    const results = await loadSkins(modsRoot);
    loaded = new Map(results.flatMap(result => (result.ok ? [[result.skin.manifest.id, result.skin] as const] : [])));
    latest = results.map(toSummary);
    for (const result of results) {
      if (!result.ok) console.warn(`SKINS: ${result.id} rejected: ${result.error}`);
    }
    return latest;
  };

  const broadcast = (summaries: SkinSummary[]) => {
    for (const window of appWindows()) window.webContents.send(IPC_CHANNELS.skinsChanged, summaries);
  };

  ipcMain.handle(IPC_CHANNELS.skinsList, () => scan());

  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const changed = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      scan()
        .then(broadcast)
        .catch((error: unknown) => console.warn(`SKINS: rescan failed: ${String(error)}`));
    }, RESCAN_DEBOUNCE_MS);
  };

  // Created up front so there is a folder to drop a skin into, and to watch.
  void mkdir(modsRoot, { recursive: true })
    .then(() => {
      try {
        watcher = watch(modsRoot, { recursive: true, persistent: false }, changed);
        watcher.on('error', () => watcher?.close());
      } catch {
        // Not watchable here (recursive watch is unsupported on some Linux setups): Refresh still rescans.
      }
    })
    .catch((error: unknown) => console.warn(`SKINS: could not create ${modsRoot}: ${String(error)}`));

  app.on('will-quit', () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  });
}

export function toSummary(result: SkinLoadResult): SkinSummary {
  if (!result.ok) {
    return { status: 'broken', id: result.id, ...(result.name ? { name: result.name } : {}), error: result.error };
  }
  const { manifest, tokens } = result.skin;
  return {
    status: 'ok',
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    tokens: withAssetUrls(manifest.id, tokens),
  };
}

function withAssetUrls(id: string, tokens: SkinTokens): SkinTokens {
  const toUrls = <T extends Record<string, string | undefined>>(paths: T | undefined): T | undefined =>
    paths &&
    (Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, path === undefined ? undefined : skinAssetUrl(id, path)])
    ) as T);
  const { sprites, sounds, ...rest } = tokens;
  return {
    ...rest,
    ...(sprites ? { sprites: toUrls(sprites) } : {}),
    ...(sounds ? { sounds: toUrls(sounds) } : {}),
  };
}
