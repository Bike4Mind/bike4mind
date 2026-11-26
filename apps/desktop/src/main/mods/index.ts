import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  mapSceneSkinAssets,
  skinAssetUrl,
  type SkinSummary,
  type SkinTokens,
  type SoundPackEvent,
  type SoundPackSummary,
} from '@shared/mods';
import { needsYouLookalikeKeys } from '@shared/needsYouColor';
import { appWindows } from '../windows';
import {
  loadSkins,
  loadSoundPacks,
  type LoadedSkin,
  type LoadedSoundPack,
  type SkinLoadResult,
  type SoundPackLoadResult,
} from './skinFolder';
import { registerSkinProtocol, type ServedMod } from './skinProtocol';

// A copy into the folder fires a burst of events; one rescan after it settles is enough.
const RESCAN_DEBOUNCE_MS = 300;

/**
 * Tier 1 mods: data-only skins read from userData/mods/<id>/. Main validates every folder
 * (skinFolder.ts), serves only the files a valid skin references (skinProtocol.ts), and gives the
 * renderer validated tokens with asset URLs. The folder is watched, and the renderer's Refresh rescans.
 */
export function registerSkins(): void {
  const modsRoot = join(app.getPath('userData'), 'mods');
  let loadedSkins = new Map<string, LoadedSkin>();
  let loadedPacks = new Map<string, LoadedSoundPack>();
  let generation = 0;

  // One scheme for both kinds; a folder is one mod, so a skin and a pack never share an id.
  registerSkinProtocol(() => new Map<string, ServedMod>([...loadedSkins, ...loadedPacks]));

  const scan = async (): Promise<ModSummaries> => {
    const mine = ++generation;
    const [skinResults, packResults] = await Promise.all([loadSkins(modsRoot), loadSoundPacks(modsRoot)]);
    const summaries: ModSummaries = {
      skins: skinResults.map(toSummary),
      soundPacks: packResults.map(toSoundPackSummary),
    };
    // An older scan can finish after a newer one; only the newest may publish. Every caller still
    // gets its own scan back, so an overlapping list call never receives a stale (or empty) answer.
    if (mine === generation) {
      loadedSkins = new Map(
        skinResults.flatMap(result => (result.ok ? [[result.skin.manifest.id, result.skin] as const] : []))
      );
      loadedPacks = new Map(
        packResults.flatMap(result => (result.ok ? [[result.pack.manifest.id, result.pack] as const] : []))
      );
    }
    for (const result of skinResults) {
      if (!result.ok) console.warn(`SKINS: ${result.id} rejected: ${result.error}`);
      else
        for (const key of needsYouLookalikeKeys(result.skin.tokens))
          console.warn(`SKINS: ${result.skin.manifest.id}: ignoring ${key}, too close to the needs-you colour`);
    }
    for (const result of packResults) {
      if (!result.ok) console.warn(`SKINS: sound pack ${result.id} rejected: ${result.error}`);
    }
    return summaries;
  };

  const broadcast = (summaries: ModSummaries) => {
    for (const window of appWindows()) {
      window.webContents.send(IPC_CHANNELS.skinsChanged, summaries.skins);
      window.webContents.send(IPC_CHANNELS.soundPacksChanged, summaries.soundPacks);
    }
  };

  ipcMain.handle(IPC_CHANNELS.skinsList, async () => (await scan()).skins);
  ipcMain.handle(IPC_CHANNELS.soundPacksList, async () => (await scan()).soundPacks);

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
        watcher.on('error', (error: unknown) => {
          console.warn(`SKINS: watcher stopped: ${String(error)}`);
          watcher?.close();
        });
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

interface ModSummaries {
  skins: SkinSummary[];
  soundPacks: SoundPackSummary[];
}

export function toSoundPackSummary(result: SoundPackLoadResult): SoundPackSummary {
  if (!result.ok) {
    return { status: 'broken', id: result.id, ...(result.name ? { name: result.name } : {}), error: result.error };
  }
  const { manifest } = result.pack;
  return {
    status: 'ok',
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    sounds: Object.fromEntries(
      Object.entries(manifest.sounds).map(([event, path]) => [event, skinAssetUrl(manifest.id, path)])
    ) as Partial<Record<SoundPackEvent, string>>,
  };
}

export function toSummary(result: SkinLoadResult): SkinSummary {
  if (!result.ok) {
    return { status: 'broken', id: result.id, ...(result.name ? { name: result.name } : {}), error: result.error };
  }
  const { manifest, tokens } = result.skin;
  const warnings = needsYouLookalikeKeys(tokens).map(
    key => `${key} is too close to the needs-you colour, so the default is used`
  );
  return {
    status: 'ok',
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.author ? { author: manifest.author } : {}),
    ...(manifest.description ? { description: manifest.description } : {}),
    tokens: withAssetUrls(manifest.id, tokens),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function withAssetUrls(id: string, tokens: SkinTokens): SkinTokens {
  const toUrls = <T extends Record<string, string | undefined>>(paths: T | undefined): T | undefined =>
    paths &&
    (Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, path === undefined ? undefined : skinAssetUrl(id, path)])
    ) as T);
  const { scenes, sounds, ...rest } = tokens;
  const { 'needs-you': _locked, ...servedSounds } = sounds ?? {};
  return {
    ...rest,
    ...(scenes
      ? {
          scenes: Object.fromEntries(
            Object.entries(scenes).map(([scene, block]) => [
              scene,
              mapSceneSkinAssets(block, path => skinAssetUrl(id, path)),
            ])
          ),
        }
      : {}),
    ...(sounds ? { sounds: toUrls(servedSounds) } : {}),
  };
}
