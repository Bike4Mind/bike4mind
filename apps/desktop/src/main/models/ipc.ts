import type { IpcMain } from 'electron';
import { isHubRepoId } from '@bike4mind/local-models';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelHubService } from './ModelHubService';

const MAX_TEXT = 512;

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

/** A server id from the renderer: omitted means this computer; null when it is present but not an id. */
export function serverArg(value: unknown): { id: string | undefined } | null {
  if (value === undefined) return { id: undefined };
  const id = text(value);
  return id ? { id } : null;
}

export const invalid = { ok: false, error: { kind: 'invalid', message: 'Invalid request.' } } as const;

const invalidStatus = {
  reachable: false,
  version: null,
  url: '',
  error: 'Invalid request.',
  serverId: '',
  serverName: 'Model server',
  management: 'unsupported',
} as const;

/** The Models screen's handlers. Which servers allow pulls and removals is decided in the service, not here. */
export function registerModelsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: Pick<
    ModelHubService,
    | 'status'
    | 'installed'
    | 'pulls'
    | 'search'
    | 'detail'
    | 'curatedPull'
    | 'checkCurated'
    | 'pull'
    | 'cancel'
    | 'resume'
    | 'dismiss'
    | 'remove'
  >
): void {
  ipc.handle(IPC_CHANNELS.modelsGetStatus, (_event, value: unknown) => {
    const target = serverArg(value);
    return target ? service.status(target.id) : invalidStatus;
  });
  ipc.handle(IPC_CHANNELS.modelsListInstalled, (_event, value: unknown) => {
    const target = serverArg(value);
    return target ? service.installed(target.id) : invalid;
  });
  ipc.handle(IPC_CHANNELS.modelsListPulls, () => service.pulls());
  ipc.handle(IPC_CHANNELS.modelsSearch, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const query = typeof body?.query === 'string' ? body.query.slice(0, MAX_TEXT) : null;
    if (query === null) return invalid;
    return service.search({ query, cursor: text(body?.cursor) });
  });
  ipc.handle(IPC_CHANNELS.modelsGetDetail, (_event, repo: unknown, value: unknown) => {
    const id = text(repo);
    const target = serverArg(value);
    return id && target ? service.detail(id, target.id) : invalid;
  });
  ipc.handle(IPC_CHANNELS.modelsGetCuratedPull, (_event, entryId: unknown, buildId: unknown, value: unknown) => {
    const entry = text(entryId);
    const build = text(buildId);
    const target = serverArg(value);
    return entry && build && target ? service.curatedPull(entry, build, target.id) : invalid;
  });
  ipc.handle(IPC_CHANNELS.modelsCheckCurated, (_event, entryId: unknown, buildId: unknown, value: unknown) => {
    const entry = text(entryId);
    const build = text(buildId);
    const target = serverArg(value);
    return entry && build && target ? service.checkCurated(entry, build, target.id) : invalid;
  });
  ipc.handle(IPC_CHANNELS.modelsPull, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const repo = text(body?.repo);
    const buildId = text(body?.buildId);
    const revision = text(body?.revision);
    const sizeBytes = body?.sizeBytes;
    const target = serverArg(body?.serverId);
    const curatedBody =
      body?.curated && typeof body.curated === 'object' ? (body.curated as Record<string, unknown>) : null;
    const curated = curatedBody ? { entryId: text(curatedBody.entryId), buildId: text(curatedBody.buildId) } : null;
    if (body?.curated !== undefined && (!curated?.entryId || !curated.buildId)) return { ...invalid, listed: false };
    if (
      !repo ||
      // A curated library build names an Ollama library ref; the service checks it against the reviewed list.
      (!curated && !isHubRepoId(repo)) ||
      !buildId ||
      !revision ||
      typeof sizeBytes !== 'number' ||
      !Number.isSafeInteger(sizeBytes) ||
      !target
    )
      return { ...invalid, listed: false };
    return service.pull({
      repo,
      buildId,
      revision,
      sizeBytes,
      acceptLicense: body?.acceptLicense === true,
      confirmAccess: body?.confirmAccess === true,
      serverId: target.id,
      ...(curated?.entryId && curated.buildId
        ? { curated: { entryId: curated.entryId, buildId: curated.buildId } }
        : {}),
    });
  });
  ipc.handle(IPC_CHANNELS.modelsCancelPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.cancel(id);
  });
  ipc.handle(IPC_CHANNELS.modelsResumePull, (_event, key: unknown) => {
    const id = text(key);
    return id ? service.resume(id) : { ...invalid, listed: false };
  });
  ipc.handle(IPC_CHANNELS.modelsDismissPull, (_event, key: unknown) => {
    const id = text(key);
    if (id) service.dismiss(id);
  });
  ipc.handle(IPC_CHANNELS.modelsRemove, (_event, name: unknown, value: unknown) => {
    const id = text(name);
    const target = serverArg(value);
    return id && target ? service.remove(id, target.id) : invalid;
  });
}
