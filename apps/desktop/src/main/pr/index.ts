import { ipcMain } from 'electron';
import type { PrBarState } from '@shared/pullRequest';
import { IPC_CHANNELS } from '@shared/ipc';
import type { ChatService } from '../chat/ChatService';
import type { SessionStore } from '../chat/SessionStore';
import { currentBranch } from '../chat/project/git';
import { runGh } from './gh';
import { PrGithub } from './github';
import { PrBindingStore } from './PrBindingStore';
import { PrMonitor, type PrMonitorLogger } from './PrMonitor';

export interface RegisterPullRequestsOptions {
  path: string;
  /** Lazy, because the service is built after this and is only needed once a session acts. */
  chat: () => ChatService;
  store: SessionStore;
  logger: PrMonitorLogger;
  send(channel: string, payload: unknown): void;
}

/** Build the PR monitor and expose it to the renderer. */
export function registerPullRequests(options: RegisterPullRequestsOptions): PrMonitor {
  const { store, logger, send } = options;
  const watchedSenders = new Set<number>();
  const monitor = new PrMonitor({
    store: new PrBindingStore(options.path),
    github: new PrGithub(runGh),
    logger,
    emit: (state: PrBarState) => send(IPC_CHANNELS.prStateChanged, state),
    chat: {
      project: async sessionId => {
        const session = await store.get(sessionId);
        const project = session?.mode === 'code' ? session.project : undefined;
        if (!project) return null;
        const branch = project.workspaceBranch ?? (await currentBranch(project.workingDirectory).catch(() => null));
        return { workingDirectory: project.workingDirectory, branch };
      },
    },
  });

  ipcMain.handle(IPC_CHANNELS.prWatch, (event, sessionId: unknown) => {
    const sender = event.sender;
    // A window that goes away must stop counting as one showing its conversation.
    if (!watchedSenders.has(sender.id)) {
      watchedSenders.add(sender.id);
      sender.once('destroyed', () => {
        watchedSenders.delete(sender.id);
        monitor.unwatch(sender.id);
      });
    }
    return monitor.watch(sender.id, typeof sessionId === 'string' ? sessionId : null);
  });
  ipcMain.handle(IPC_CHANNELS.prBind, (_event, sessionId: unknown, url: unknown) =>
    typeof sessionId === 'string' && typeof url === 'string'
      ? monitor.bindManual(sessionId, url)
      : { ok: false, error: 'A conversation and a URL are required.' }
  );
  ipcMain.handle(IPC_CHANNELS.prDismiss, (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? monitor.dismiss(sessionId) : { ok: true }
  );
  ipcMain.handle(IPC_CHANNELS.prRefresh, (_event, sessionId: unknown) =>
    typeof sessionId === 'string' ? monitor.refresh(sessionId) : undefined
  );
  return monitor;
}
