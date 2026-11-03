import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UsageWindowId } from '@shared/usage';
import type { AuthService } from '../auth';
import { sessionScopeForChat, sessionScopeKey } from '../chat/sessionScope';
import type { SessionStore } from '../chat/SessionStore';
import { createMainLogger } from '../logger';
import type { ModelServerRegistry } from '../modelServers/ModelServerRegistry';
import { LocalUsageService } from './LocalUsageService';
import { UsageService } from './UsageService';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/**
 * Build the usage service and expose its one read over IPC.
 *
 * In main for the same reason the balance is: these are authenticated reads, and the access
 * token never crosses the bridge.
 */
export function registerUsage(auth: AuthService): UsageService {
  const service = new UsageService({
    logger: createMainLogger(VERBOSE),
    getApiClient: () => auth.getApiClient(),
    getUserId: () => auth.getState().user?.id ?? null,
  });

  ipcMain.handle(IPC_CHANNELS.usageGetHistory, (_event, window: UsageWindowId, force?: boolean) =>
    service.history(window, force ?? false)
  );

  return service;
}

/** Self-hosted model usage, read from the session store in whichever scope chat is in. */
export function registerLocalUsage(
  auth: AuthService,
  store: Pick<SessionStore, 'localUsageBuckets'>,
  servers: Pick<ModelServerRegistry, 'views'>
): LocalUsageService {
  const service = new LocalUsageService({
    logger: createMainLogger(VERBOSE),
    buckets: () => store.localUsageBuckets(),
    scopeKey: () => {
      const scope = sessionScopeForChat(auth.getState());
      return scope ? sessionScopeKey(scope) : null;
    },
    serverNames: async () => new Map((await servers.views()).map(server => [server.id, server.name])),
  });

  ipcMain.handle(IPC_CHANNELS.usageGetLocal, (_event, window: UsageWindowId, force?: boolean) =>
    service.usage(window, force ?? false)
  );

  return service;
}

export { UsageService } from './UsageService';
