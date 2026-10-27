import { ipcMain } from 'electron';
import { HuggingFaceHub, OllamaRuntime, ollamaLibraryLayers, probeHardware } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelPull } from '@shared/models';
import { localHardware } from '../chat/localContextSizing';
import { appWindows } from '../windows';
import { loadCuratedManifest } from './loadCuratedManifest';
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
 * The Models screen's backend. Hugging Face is only reached from here, never the renderer. The app keeps no
 * Hugging Face token, so gated and private repos cannot be verified or pulled yet.
 */
export function registerModels({ localContext }: Pick<ModelHubServiceDeps, 'localContext'>): ModelHubService {
  const send = (channel: string, payload?: ModelPull[]) => {
    for (const window of appWindows()) window.webContents.send(channel, payload);
  };
  const service = new ModelHubService({
    // The same daemon OllamaLocal chats with, so a pulled model shows up in the picker.
    runtime: new OllamaRuntime({ healthTimeoutMs: RUNTIME_HEALTH_TIMEOUT_MS }),
    hub: new HuggingFaceHub(),
    libraryLayers: (ref, options) => ollamaLibraryLayers(ref, options),
    // Chat's own probe, so badges and chat size context from the same reading of this machine.
    hardware: () => localHardware.profile().then(profile => profile ?? probeHardware()),
    localContext,
    curated: loadCuratedManifest(warn),
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
  ipcMain.handle(IPC_CHANNELS.modelsListCurated, () => service.curated());
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

  return service;
}

export { ModelHubService } from './ModelHubService';
