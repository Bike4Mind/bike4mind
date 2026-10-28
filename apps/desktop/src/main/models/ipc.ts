import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ModelHubService } from './ModelHubService';

const MAX_TEXT = 512;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT ? value : null;
}

/** A server id from the renderer; anything else means this computer. */
function serverId(value: unknown): string | undefined {
  return text(value) ?? undefined;
}

const invalid = { ok: false, error: { kind: 'invalid', message: 'Invalid request.' } } as const;

/** The Models screen's handlers. Which servers allow pulls and removals is decided in the service, not here. */
export function registerModelsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  service: Pick<
    ModelHubService,
    'status' | 'installed' | 'pulls' | 'search' | 'detail' | 'pull' | 'cancel' | 'resume' | 'dismiss' | 'remove'
  >
): void {
  ipc.handle(IPC_CHANNELS.modelsGetStatus, (_event, server: unknown) => service.status(serverId(server)));
  ipc.handle(IPC_CHANNELS.modelsListInstalled, (_event, server: unknown) => service.installed(serverId(server)));
  ipc.handle(IPC_CHANNELS.modelsListPulls, () => service.pulls());
  ipc.handle(IPC_CHANNELS.modelsSearch, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const query = typeof body?.query === 'string' ? body.query.slice(0, MAX_TEXT) : null;
    if (query === null) return invalid;
    return service.search({ query, cursor: text(body?.cursor) });
  });
  ipc.handle(IPC_CHANNELS.modelsGetDetail, (_event, repo: unknown) => {
    const id = text(repo);
    return id ? service.detail(id) : invalid;
  });
  ipc.handle(IPC_CHANNELS.modelsPull, (_event, request: unknown) => {
    const body = request && typeof request === 'object' ? (request as Record<string, unknown>) : null;
    const repo = text(body?.repo);
    const buildId = text(body?.buildId);
    const revision = text(body?.revision);
    const sizeBytes = body?.sizeBytes;
    if (!repo || !buildId || !revision || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes))
      return { ...invalid, listed: false };
    return service.pull({
      repo,
      buildId,
      revision,
      sizeBytes,
      acceptLicense: body?.acceptLicense === true,
      confirmAccess: body?.confirmAccess === true,
      serverId: serverId(body?.serverId),
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
  ipc.handle(IPC_CHANNELS.modelsRemove, (_event, name: unknown, server: unknown) => {
    const id = text(name);
    return id ? service.remove(id, serverId(server)) : invalid;
  });
}
