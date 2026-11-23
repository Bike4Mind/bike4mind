import type { IpcMain } from 'electron';
import { COMPLETION_RUN_MAX_BUDGET_CREDITS } from '@bike4mind/common';
import type { ChatSessionSummary, RaiseRunBudgetResult } from '@shared/chat';
import { IPC_CHANNELS } from '@shared/ipc';

export interface SessionOrchestrate {
  setSessionOrchestrate(
    sessionId: string,
    orchestrate: boolean,
    budgetCredits?: number
  ): Promise<ChatSessionSummary | null>;
  raiseRunBudget(sessionId: string, budgetCredits: number): Promise<RaiseRunBudgetResult>;
}

const isCredits = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= COMPLETION_RUN_MAX_BUDGET_CREDITS;

export function registerSessionOrchestrateIpc(ipc: Pick<IpcMain, 'handle'>, service: SessionOrchestrate): void {
  // Validated rather than trusted: the flag lets spawns start without a card, so only a real
  // boolean may set it. A budget is optional, but one that is sent must be a positive integer
  // within the server's ceiling.
  ipc.handle(
    IPC_CHANNELS.chatSetSessionOrchestrate,
    (_event, sessionId: unknown, orchestrate: unknown, budgetCredits?: unknown) => {
      if (typeof sessionId !== 'string' || typeof orchestrate !== 'boolean') return null;
      if (budgetCredits === undefined) return service.setSessionOrchestrate(sessionId, orchestrate);
      return isCredits(budgetCredits) ? service.setSessionOrchestrate(sessionId, orchestrate, budgetCredits) : null;
    }
  );
  ipc.handle(IPC_CHANNELS.chatRaiseRunBudget, (_event, sessionId: unknown, budgetCredits: unknown) =>
    typeof sessionId === 'string' && isCredits(budgetCredits)
      ? service.raiseRunBudget(sessionId, budgetCredits)
      : { ok: false, error: 'Enter a whole number of credits.' }
  );
}
