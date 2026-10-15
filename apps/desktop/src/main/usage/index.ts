import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { UsageWindowId } from '@shared/usage';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
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

export { UsageService } from './UsageService';
