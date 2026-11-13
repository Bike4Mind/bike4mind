import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AutoFixAttemptsPreference } from './AutoFixAttemptsPreference';

export interface AutoFixAttemptsIpcDeps {
  preference: Pick<AutoFixAttemptsPreference, 'read' | 'record'>;
  /** Hands the saved value to the PR monitor; see PrMonitor.setAutoFixAttempts. */
  apply(attempts: number): Promise<void>;
}

export function registerAutoFixAttemptsIpc(ipc: Pick<IpcMain, 'handle'>, deps: AutoFixAttemptsIpcDeps): void {
  ipc.handle(IPC_CHANNELS.prGetAutoFixAttempts, () => deps.preference.read());
  ipc.handle(IPC_CHANNELS.prSetAutoFixAttempts, async (_event, attempts: unknown) => {
    const saved = await deps.preference.record(attempts);
    await deps.apply(saved);
    return saved;
  });
}
