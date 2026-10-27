import { join } from 'node:path';
import { app, ipcMain, safeStorage } from 'electron';
import {
  HuggingFaceHub,
  OllamaRuntime,
  ollamaLibraryLayers,
  probeHardware,
} from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CuratedList, HfTokenResult, ModelPull } from '@shared/models';
import { localHardware } from '../chat/localContextSizing';
import { createMainLogger } from '../logger';
import { privateFile } from '../privateFile';
import { appWindows } from '../windows';
import { HuggingFaceTokenStore } from './HuggingFaceTokenStore';
import { BUNDLED_CURATED_TEXT } from './curated/bundled';
import { CuratedSource } from './curated/CuratedSource';
import { CuratedStore, curatedStoreRoot } from './curated/CuratedStore';
import { curatedDevOverrides } from './curated/devKey';
import { resolveCuratedUrl } from './curated/fetchCurated';
import { PRODUCTION_CURATED_KEYS } from './curated/keys';
import { ModelHubService, type ModelHubServiceDeps } from './ModelHubService';

const MAX_TEXT = 512;
// Room for a daemon busy finishing a pull on a loaded machine, which the library's short default reads as stopped.
const RUNTIME_HEALTH_TIMEOUT_MS = 10_000;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

const invalid = { ok: false, error: { kind: 'invalid', message: 'Invalid request.' } } as const;
const warn = (message: string) => console.warn(message);

/**
 * The curated list's source. The URL is baked in at build time from B4M_CURATED_MANIFEST_URL (see the `define`
 * block in electron.vite.config.ts); a fork that sets nothing, or a build with no trusted key, uses its bundled list.
 */
function curatedSource(onChange: () => void): CuratedSource {
  const allowLoopbackHttp = !app.isPackaged;
  // A constant false in release builds, so the test key and its module are not in the bundle at all.
  const dev = __B4M_CURATED_DEV_KEYS__ ? curatedDevOverrides(app.isPackaged, process.env) : null;
  return new CuratedSource({
    url: resolveCuratedUrl(dev?.url ?? process.env.B4M_CURATED_MANIFEST_URL, allowLoopbackHttp),
    keys: [...PRODUCTION_CURATED_KEYS, ...(dev?.keys ?? [])],
    store: new CuratedStore(curatedStoreRoot(app.getPath('userData'), dev !== null)),
    bundledText: BUNDLED_CURATED_TEXT,
    desktopVersion: app.getVersion(),
    allowLoopbackHttp,
    log: warn,
    onChange,
  });
}

/**
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer, and the user's Hugging
 * Face token never leaves main except as the Authorization header of requests to huggingface.co.
 */
export function registerModels({ localContext }: Pick<ModelHubServiceDeps, 'localContext'>): ModelHubService {
  const send = (channel: string, payload?: ModelPull[]) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const logger = createMainLogger(process.env.B4M_DESKTOP_VERBOSE === '1');
  const tokens = new HuggingFaceTokenStore(
    safeStorage,
    privateFile(join(app.getPath('userData'), 'hugging-face-token.json')),
    logger
  );
  const source = curatedSource(() => send(IPC_CHANNELS.modelsCuratedChanged));
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    // Default endpoint only: a token must never follow a configurable host.
    createHub: token => new HuggingFaceHub(token ? { token } : {}),
    tokens,
    libraryLayers: (ref, options) => ollamaLibraryLayers(ref, options),
    // Chat's own probe, so badges and chat size context from the same reading of this machine.
    hardware: () => localHardware.profile().then(profile => profile ?? probeHardware()),
    localContext,
    curated: () => source.current(),
    onPullsChanged: pulls => send(IPC_CHANNELS.modelsPullsChanged, pulls),
    onInstalledChanged: () => send(IPC_CHANNELS.modelsInstalledChanged),
    warn,
  });

  ipcMain.handle(IPC_CHANNELS.modelsGetStatus, () => service.status());
  ipcMain.handle(IPC_CHANNELS.modelsListInstalled, () => service.installed());
  ipcMain.handle(IPC_CHANNELS.modelsListPulls, () => service.pulls());
  ipcMain.handle(IPC_CHANNELS.modelsSearch, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const query = typeof body?.query === 'string' ? body.query.slice(0, MAX_TEXT) : null;
    if (query === null) return invalid;
    return service.search({ query, cursor: text(body?.cursor) });
  });
  ipcMain.handle(IPC_CHANNELS.modelsGetDetail, (_event, repo: unknown) => {
    const id = text(repo);
    return id ? service.detail(id) : invalid;
  });
  // Opening Models lists the curated models, so this is where a due check starts; it never blocks the list.
  ipcMain.handle(IPC_CHANNELS.modelsListCurated, async (): Promise<CuratedList> => {
    await source.loaded();
    void source.checkIfDue();
    return { ...(await service.curated()), source: source.view() };
  });
  ipcMain.handle(IPC_CHANNELS.modelsCheckCuratedList, () => source.checkNow());
  ipcMain.handle(IPC_CHANNELS.modelsCuratedSettings, async () => {
    await source.loaded();
    return source.settings();
  });
  ipcMain.handle(IPC_CHANNELS.modelsCuratedSetEnabled, (_event, enabled: unknown) =>
    typeof enabled === 'boolean' ? source.setEnabled(enabled) : source.settings()
  );
  ipcMain.handle(IPC_CHANNELS.modelsGetCuratedPull, (_event, entryId: unknown, buildId: unknown) => {
    const entry = text(entryId);
    const build = text(buildId);
    return entry && build ? service.curatedPull(entry, build) : invalid;
  });
  ipcMain.handle(IPC_CHANNELS.modelsCheckCurated, (_event, entryId: unknown, buildId: unknown) => {
    const entry = text(entryId);
    const build = text(buildId);
    return entry && build ? service.checkCurated(entry, build) : invalid;
  });
  ipcMain.handle(IPC_CHANNELS.modelsPull, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const repo = text(body?.repo);
    const buildId = text(body?.buildId);
    const revision = text(body?.revision);
    const sizeBytes = body?.sizeBytes;
    if (!repo || !buildId || !revision || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes))
      return { ...invalid, listed: false };
    const curatedBody =
      body?.curated && typeof body.curated === 'object' ? (body.curated as Record<string, unknown>) : null;
    const curated = curatedBody ? { entryId: text(curatedBody.entryId), buildId: text(curatedBody.buildId) } : null;
    if (body?.curated !== undefined && (!curated?.entryId || !curated.buildId)) return { ...invalid, listed: false };
    return service.pull({
      repo,
      buildId,
      revision,
      sizeBytes,
      acceptLicense: body?.acceptLicense === true,
      confirmAccess: body?.confirmAccess === true,
      ...(curated?.entryId && curated.buildId
        ? { curated: { entryId: curated.entryId, buildId: curated.buildId } }
        : {}),
    });
  });
  ipcMain.handle(IPC_CHANNELS.modelsCancelPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.cancel(id);
  });
  ipcMain.handle(IPC_CHANNELS.modelsDismissPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.dismiss(id);
  });
  ipcMain.handle(IPC_CHANNELS.modelsRemove, (_event, name: unknown) => {
    const id = text(name);
    return id ? service.remove(id) : invalid;
  });
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
