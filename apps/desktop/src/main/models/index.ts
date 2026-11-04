import { existsSync, readFileSync } from 'node:fs';
import { stat, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { app, ipcMain, powerSaveBlocker, safeStorage } from 'electron';
import {
  CuratedListSource,
  CuratedStore,
  type CuratedListSettings as SourceListSettings,
  type CuratedSourceView as SourceView,
  HuggingFaceHub,
  OllamaRuntime,
  PRODUCTION_CURATED_KEYS,
  curatedStoreRoot,
  ollamaLibraryLayers,
  probeHardware,
  resolveCuratedUrl,
} from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CuratedList, CuratedListSettings, CuratedSourceView, HfTokenResult, ModelPull } from '@shared/models';
import { localHardware } from '../chat/localContextSizing';
import { createMainLogger } from '../logger';
import type { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { privateFile } from '../privateFile';
import { appWindows } from '../windows';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { BUNDLED_CURATED_TEXT } from './curated/bundled';
import { curatedDevOverrides } from './curated/devKey';
import { invalid, registerModelsIpc, serverArg, text } from './ipc';
import { loadCuratedManifest } from './loadCuratedManifest';
import { ModelHubService, type ModelHubServiceDeps } from './ModelHubService';
import { PullLedger } from './pullLedger';
import { probeIntegratedGpu, runsInWsl } from './wslGpuCap';

// Room for a daemon busy finishing a pull on a loaded machine, which the library's short default reads as stopped.
const RUNTIME_HEALTH_TIMEOUT_MS = 10_000;
const LINUX_SERVICE_STORE = '/usr/share/ollama/.ollama/models';

const warn = (message: string) => console.warn(message);

function procVersion(): string | null {
  try {
    return readFileSync('/proc/version', 'utf8');
  } catch {
    return null;
  }
}

const isMissing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** Free bytes on the disk holding `path`; Ollama makes its folder on first pull, so a missing one is read upward. */
async function freeBytes(path: string): Promise<number> {
  for (let current = path; ; current = dirname(current)) {
    try {
      const stats = await statfs(current);
      return stats.bavail * stats.bsize;
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) throw error;
    }
  }
}

/** The device of the disk holding `path`, read upward like `freeBytes`. */
async function deviceOf(path: string): Promise<number> {
  for (let current = path; ; current = dirname(current)) {
    try {
      return (await stat(current)).dev;
    } catch (error) {
      if (!isMissing(error) || dirname(current) === current) throw error;
    }
  }
}

// Fails typecheck when the renderer's mirrored types in shared/models.ts drift from local-models in either direction.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const curatedTypesMatch: [Same<CuratedSourceView, SourceView>, Same<CuratedListSettings, SourceListSettings>] = [
  true,
  true,
];

/**
 * The curated list's source. The URL is baked in at build time from B4M_CURATED_MANIFEST_URL (see the `define`
 * block in electron.vite.config.ts); a fork that sets nothing, or a build with no trusted key, uses its bundled list.
 */
function curatedSource(onChange: () => void): CuratedListSource {
  const allowLoopbackHttp = !app.isPackaged;
  // A constant false in release builds, so the test key and its module are not in the bundle at all.
  const dev = __B4M_CURATED_DEV_KEYS__ ? curatedDevOverrides(app.isPackaged, process.env) : null;
  const desktopVersion = app.getVersion();
  return new CuratedListSource({
    url: resolveCuratedUrl(dev?.url ?? process.env.B4M_CURATED_MANIFEST_URL, allowLoopbackHttp),
    keys: [...PRODUCTION_CURATED_KEYS, ...(dev?.keys ?? [])],
    store: new CuratedStore(curatedStoreRoot(app.getPath('userData'), dev !== null)),
    bundledText: BUNDLED_CURATED_TEXT,
    load: json => loadCuratedManifest(warn, json, { desktopVersion }),
    allowLoopbackHttp,
    userAgent: 'Bike4Mind-Desktop',
    log: warn,
    onChange,
  });
}

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer, and the user's Hugging
 * Face token never leaves main except as the Authorization header of requests to huggingface.co.
 */
export function registerModels(
  servers: Pick<ModelServerRegistry, 'hubServer' | 'onServerSaved' | 'specs'>,
  { localContext, modelSettings }: Pick<ModelHubServiceDeps, 'localContext' | 'modelSettings'>,
  capabilityLedger: ConstructorParameters<typeof PullLedger>[0]
): ModelHubService {
  const send = (channel: string, payload?: ModelPull[] | string) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const tokens = new HuggingFaceTokenStore(
    safeStorage,
    privateFile(join(app.getPath('userData'), 'hugging-face-token.json')),
    logger
  );
  let blocker: number | null = null;
  const source = curatedSource(() => send(IPC_CHANNELS.modelsCuratedChanged));
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    server: id => servers.hubServer(id),
    // Default endpoint only: a token must never follow a configurable host.
    createHub: token => new HuggingFaceHub(token ? { token } : {}),
    tokens,
    libraryLayers: (ref, options) => ollamaLibraryLayers(ref, options),
    // Chat's own probe and entered specs, so badges and chat size context from the same reading of this machine.
    hardware: () => localHardware.probed().then(profile => profile ?? probeHardware()),
    specs: id => servers.specs(id),
    localContext,
    modelSettings,
    curated: () => source.current(),
    onPullsChanged: pulls => {
      send(IPC_CHANNELS.modelsPullsChanged, pulls);
      void ledger.settled(pulls);
    },
    onPullStarted: pull =>
      void service
        .storeLocation(pull.serverId)
        .catch(() => null)
        .then(location => ledger.started(pull, location)),
    freeSpace: freeBytes,
    // Ollama's own default; a daemon started with OLLAMA_MODELS elsewhere shows its folder once a model is installed.
    defaultStoreDir: () => {
      if (process.env.OLLAMA_MODELS) return process.env.OLLAMA_MODELS;
      // The official Linux install script runs the daemon as its own user, whose home is here.
      if (process.platform === 'linux' && existsSync(LINUX_SERVICE_STORE)) return LINUX_SERVICE_STORE;
      return join(homedir(), '.ollama', 'models');
    },
    pathExists: async path => (await stat(path)).isDirectory(),
    wslHost: process.platform === 'win32' || (process.platform === 'linux' && runsInWsl(process.env, procVersion())),
    integratedGpu: () => probeIntegratedGpu(),
    importDir: () => join(app.getPath('userData'), 'model-imports'),
    sameDisk: async (a, b) => (await deviceOf(a)) === (await deviceOf(b)),
    // Once, right away: the picker's reload waits for any recheck the pull or removal started.
    onInstalledChanged: serverId => send(IPC_CHANNELS.modelsInstalledChanged, serverId),
    keepAwake: on => {
      if (on && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
      if (!on && blocker !== null) {
        powerSaveBlocker.stop(blocker);
        blocker = null;
      }
    },
    warn,
  });
  const ledger = new PullLedger(capabilityLedger, () => service.pulls(), warn);
  void ledger.retireAll();
  servers.onServerSaved(id => {
    service.serverChanged(id);
    // Entered hardware may have changed, which re-rates the open lists.
    send(IPC_CHANNELS.modelsInstalledChanged, id);
    send(IPC_CHANNELS.modelsCuratedChanged);
  });
  registerModelsIpc(ipcMain, service);

  // Opening Models lists the curated models, so this is where a due check starts; it never blocks the list.
  ipcMain.handle(
    IPC_CHANNELS.modelsListCurated,
    async (_event, value: unknown): Promise<CuratedList | typeof invalid> => {
      const target = serverArg(value);
      if (!target) return invalid;
      await source.loaded();
      void source.checkIfDue();
      const sourceView = source.view();
      return { ...(await service.curated(target.id)), source: sourceView };
    }
  );
  ipcMain.handle(IPC_CHANNELS.modelsCheckCuratedList, () => source.checkNow());
  ipcMain.handle(IPC_CHANNELS.modelsCuratedSettings, async () => {
    await source.loaded();
    return source.settings();
  });
  ipcMain.handle(IPC_CHANNELS.modelsCuratedSetEnabled, (_event, enabled: unknown) =>
    typeof enabled === 'boolean' ? source.setEnabled(enabled) : source.settings()
  );
  ipcMain.handle(IPC_CHANNELS.modelsGetHfAccess, () => service.tokenStatus());
  const publishTokenResult = (result: HfTokenResult, senderId: number): HfTokenResult => {
    if (result.ok) {
      for (const window of appWindows()) {
        if (window.webContents.id !== senderId)
          window.webContents.send(IPC_CHANNELS.modelsHfAccessChanged, result.status);
      }
    }
    return result;
  };
  ipcMain.handle(IPC_CHANNELS.modelsSaveHfAccess, async (event, token: unknown) => {
    const value = text(token);
    return value ? publishTokenResult(await service.setToken(value), event.sender.id) : invalid;
  });
  ipcMain.handle(IPC_CHANNELS.modelsClearHfAccess, async event =>
    publishTokenResult(await service.clearToken(), event.sender.id)
  );

  return service;
}

export { ModelHubService } from './ModelHubService';
