import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { AttentionOpenEvent } from '@shared/attention';
import { IPC_CHANNELS } from '@shared/ipc';
import { parseOrchestrateMiniPayload, type OrchestrateMiniPayload } from '@shared/orchestrateMini';

export type OrchestrateMiniIpcDeps = {
  /** True for an app window's contents (windows.ts appWindows): only a stage may publish or toggle. */
  isAppWindow(sender: WebContents): boolean;
  /** True only for the Orchestrate mini window's own contents. */
  isMiniWindow(sender: WebContents): boolean;
  current(): OrchestrateMiniPayload | null;
  publish(payload: OrchestrateMiniPayload | null, publisher: WebContents): void;
  isOpen(): boolean;
  toggle(): void;
  close(): void;
  openSession(open: AttentionOpenEvent): void;
};

/**
 * Where a click on `agentId` in the mini window may take the main window: to the decision that agent
 * waits on, or to the root's own approval. Anything else in the payload (or not in it) goes nowhere, so a
 * stale or forged id cannot raise the app on an arbitrary session.
 */
export function focusTarget(payload: OrchestrateMiniPayload | null, agentId: unknown): AttentionOpenEvent | null {
  if (!payload || typeof agentId !== 'string') return null;
  const { root, agents } = payload.snapshot;
  const waiting =
    agentId === root.id
      ? root.state === 'needs-you'
      : agents.some(agent => agent.id === agentId && agent.state === 'needs-you');
  return waiting ? { sessionId: agentId, rootId: root.id } : null;
}

/**
 * The Orchestrate mini window's surface. Publishing and toggling answer app windows only; reading and
 * focusing answer the mini window only. The payload is parsed on receipt and a malformed one dropped.
 */
export function registerOrchestrateMiniIpc(deps: OrchestrateMiniIpcDeps): void {
  const fromApp = (event: IpcMainInvokeEvent) => deps.isAppWindow(event.sender);
  const fromMini = (event: IpcMainInvokeEvent) => deps.isMiniWindow(event.sender);

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniPublish, (event, payload: unknown): void => {
    if (!fromApp(event)) return;
    const parsed = parseOrchestrateMiniPayload(payload);
    if (parsed === undefined) {
      console.warn('ORCHESTRATE-MINI: dropped a payload that does not match the schema');
      return;
    }
    // A publish still in flight when the window closed would re-cache a payload main just dropped, and a
    // reopened window could then show it from before Presenter mode was turned on.
    if (parsed !== null && !deps.isOpen()) return;
    deps.publish(parsed, event.sender);
  });

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniToggle, (event): boolean => {
    if (fromApp(event)) deps.toggle();
    return deps.isOpen();
  });

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniGetOpen, (): boolean => deps.isOpen());

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniGetSnapshot, (event): OrchestrateMiniPayload | null =>
    fromMini(event) ? deps.current() : null
  );

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniFocus, (event, agentId: unknown): void => {
    if (!fromMini(event)) return;
    const target = focusTarget(deps.current(), agentId);
    if (target) deps.openSession(target);
  });

  ipcMain.handle(IPC_CHANNELS.orchestrateMiniClose, (event): void => {
    if (fromMini(event)) deps.close();
  });
}
