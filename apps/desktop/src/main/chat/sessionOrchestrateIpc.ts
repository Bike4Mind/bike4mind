import type { IpcMain } from 'electron';
import type { ChatSessionSummary } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';

export interface SessionOrchestrate {
  setSessionOrchestrate(sessionId: string, orchestrate: boolean): Promise<ChatSessionSummary | null>;
}

export function registerSessionOrchestrateIpc(ipc: Pick<IpcMain, 'handle'>, service: SessionOrchestrate): void {
  // Validated rather than trusted: the flag lets spawns start without a card, so only a real
  // boolean may set it.
  ipc.handle(IPC_CHANNELS.chatSetSessionOrchestrate, (_event, sessionId: unknown, orchestrate: unknown) =>
    typeof sessionId === 'string' && typeof orchestrate === 'boolean'
      ? service.setSessionOrchestrate(sessionId, orchestrate)
      : null
  );
}
