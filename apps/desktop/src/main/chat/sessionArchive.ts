import type { ChatService } from './ChatService';
import type { SessionStore } from './SessionStore';

/** The question asked before archiving a parent session; shaped so Electron's message box takes it as is. */
export type ArchiveConfirmation = {
  type: 'question';
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  noLink: boolean;
};

export type ArchiveConfirmationAnswer = { response: number; checkboxChecked: boolean };

export type ConfirmArchive = (confirmation: ArchiveConfirmation) => Promise<ArchiveConfirmationAnswer>;

export async function archiveFromSidebar(
  service: Pick<ChatService, 'listSessions' | 'childArchiveStatus' | 'setSessionArchived' | 'archiveFinishedChildren'>,
  store: Pick<SessionStore, 'scopeKey'>,
  sessionId: string,
  archived: boolean,
  confirm: ConfirmArchive
) {
  if (!archived) return service.setSessionArchived(sessionId, false);
  const scope = store.scopeKey();
  const sessions = await service.listSessions();
  if (store.scopeKey() !== scope) return null;
  const parent = sessions.find(session => session.id === sessionId);
  if (!parent) return null;
  const children = sessions.filter(session => session.origin?.parentSessionId === sessionId && !session.archived);
  const finished = children.filter(session => service.childArchiveStatus(session) === 'finished');
  let includeChildren = false;
  if (children.length > 0) {
    const finishedIds = new Set(finished.map(session => session.id));
    const kept = children.filter(session => !finishedIds.has(session.id));
    const result = await confirm({
      type: 'question',
      message: `Archive "${parent.title}"?`,
      detail: [
        'Nothing is deleted. Archived conversations can be restored from the sidebar.',
        ...finished.map(session => `Finished: ${session.title}`),
        ...kept.map(session => `Kept (${service.childArchiveStatus(session)}): ${session.title}`),
        'Running sessions and sessions waiting on you will be kept, even if their status changes before you confirm.',
      ].join('\n'),
      buttons: ['Archive', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      ...(finished.length > 0
        ? {
            checkboxLabel: `Also archive finished sub-sessions (${finished.length})`,
            checkboxChecked: true,
          }
        : {}),
      noLink: true,
    });
    if (result.response !== 0) return null;
    includeChildren = finished.length > 0 && result.checkboxChecked;
  }
  if (store.scopeKey() !== scope) return null;
  const updated = await service.setSessionArchived(sessionId, true);
  if (updated && includeChildren)
    await service.archiveFinishedChildren(
      sessionId,
      finished.map(session => session.id),
      scope
    );
  return updated;
}
