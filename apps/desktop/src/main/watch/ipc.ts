import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import {
  EMPTY_WATCH_SNAPSHOT,
  isWatchDecision,
  watchPreferencesPatchSchema,
  type WatchPreferences,
  type WatchPreferencesPatch,
  type WatchSnapshot,
} from '@shared/watch';

export type WatchIpcDeps = {
  snapshot(): WatchSnapshot;
  respond(approvalId: string, decision: 'once' | 'deny'): Promise<boolean>;
  openSession(open: AttentionOpenEvent): void;
  /** True only for the mini Tavern window's own contents. */
  isMiniWindow(sender: WebContents): boolean;
  closeMini(): void;
  preferences(): WatchPreferences;
  setPreferences(patch: WatchPreferencesPatch): Promise<WatchPreferences>;
};

/** Whether `sessionId` is the root or an agent of the orchestration `rootId` in this snapshot. */
export function isWatchedSession(snapshot: WatchSnapshot, sessionId: string, rootId: string): boolean {
  const orchestration = snapshot.orchestrations.find(candidate => candidate.rootId === rootId);
  return !!orchestration && (sessionId === rootId || orchestration.agents.some(agent => agent.id === sessionId));
}

/**
 * The mini Tavern's surface and the Settings toggle. Every mini call is checked against the
 * sender, so no other window (or a page that somehow got a bridge) can answer approvals here, and
 * every argument is validated: "always" never crosses this boundary.
 */
export function registerWatchIpc(deps: WatchIpcDeps): void {
  const fromMini = (event: IpcMainInvokeEvent) => deps.isMiniWindow(event.sender);

  ipcMain.handle(IPC_CHANNELS.watchGetSnapshot, (event): WatchSnapshot =>
    fromMini(event) ? deps.snapshot() : EMPTY_WATCH_SNAPSHOT
  );

  ipcMain.handle(IPC_CHANNELS.watchRespond, async (event, approvalId: unknown, decision: unknown): Promise<boolean> => {
    if (!fromMini(event) || typeof approvalId !== 'string' || approvalId === '' || !isWatchDecision(decision)) {
      return false;
    }
    return deps.respond(approvalId, decision);
  });

  ipcMain.handle(IPC_CHANNELS.watchFocusAgent, (event, sessionId: unknown, rootId: unknown): void => {
    if (!fromMini(event) || typeof sessionId !== 'string' || typeof rootId !== 'string') return;
    if (!isWatchedSession(deps.snapshot(), sessionId, rootId)) return;
    deps.openSession({ sessionId, rootId });
  });

  ipcMain.handle(IPC_CHANNELS.watchCloseMini, (event): void => {
    if (fromMini(event)) deps.closeMini();
  });

  ipcMain.handle(IPC_CHANNELS.watchGetPreferences, (): WatchPreferences => deps.preferences());

  ipcMain.handle(IPC_CHANNELS.watchSetPreferences, (_event, patch: unknown): Promise<WatchPreferences> => {
    const parsed = watchPreferencesPatchSchema.safeParse(patch);
    return parsed.success ? deps.setPreferences(parsed.data) : Promise.resolve(deps.preferences());
  });
}
