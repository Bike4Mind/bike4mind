import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AuthService } from '../auth';
import { createMainLogger } from '../logger';
import { AccountService } from './AccountService';

const VERBOSE = process.env.B4M_DESKTOP_VERBOSE === '1';

/**
 * Build the account service and expose its one read over IPC.
 *
 * Lives in main for the same reason every other server call does: the balance is an
 * authenticated read, and the access token never crosses the bridge.
 */
export function registerAccount(auth: AuthService): AccountService {
  const service = new AccountService({
    logger: createMainLogger(VERBOSE),
    getApiClient: () => auth.getApiClient(),
  });

  ipcMain.handle(IPC_CHANNELS.accountGetCredits, () => service.credits());

  return service;
}

export { AccountService } from './AccountService';
