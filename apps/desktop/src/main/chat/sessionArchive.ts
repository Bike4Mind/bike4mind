import type { ChatSessionSummary } from '@shared/chat';
import { archiveConfirmationSchema } from '@shared/hostProtocol';
import type { ArchiveAnswer, ArchiveQuestion } from '@shared/ipc';
import type { ChatService } from './ChatService';
import type { SessionStore } from './SessionStore';

type ArchiveChild = { id: string; title: string };

/** What a client needs to ask before a parent with sub-sessions is archived. */
export type ArchiveConfirmationFacts = {
  parentTitle: string;
  /** Offered for archiving with the parent, default on. */
  finished: ArchiveChild[];
  /** Always kept: they are still doing something or waiting on the user. */
  kept: Array<ArchiveChild & { status: 'running' | 'waiting' }>;
};

/**
 * How a client answered the question. `archiveChildIds` are the finished sub-sessions it showed
 * and the user chose to archive too; each is rechecked as it is archived, so one that resumed
 * while the question was open is kept.
 */
export type ArchiveDecision = { confirmed?: boolean; archiveChildIds?: readonly string[] };

/**
 * `summary` is null when nothing changed: the session is unknown to the current account, or it
 * is a parent that needs the client's confirmation first, which `confirmationRequired` carries.
 */
export type SessionArchiveResult =
  | { summary: ChatSessionSummary | null; confirmationRequired?: undefined }
  | { summary: null; confirmationRequired: ArchiveConfirmationFacts };

/** The question as Electron's message box takes it. */
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

type ArchiveService = Pick<
  ChatService,
  'listSessions' | 'childArchiveStatus' | 'setSessionArchived' | 'archiveFinishedChildren'
>;

/**
 * The sidebar's archive rule. Restoring and archiving a session without live sub-sessions happen
 * at once; archiving a parent that has some changes nothing until the decision says `confirmed`.
 */
export async function archiveFromSidebar(
  service: ArchiveService,
  store: Pick<SessionStore, 'scopeKey'>,
  sessionId: string,
  archived: boolean,
  decision: ArchiveDecision = {}
): Promise<SessionArchiveResult> {
  if (!archived) return { summary: await service.setSessionArchived(sessionId, false) };
  const scope = store.scopeKey();
  const sessions = await service.listSessions();
  if (store.scopeKey() !== scope) return { summary: null };
  const parent = sessions.find(session => session.id === sessionId);
  if (!parent) return { summary: null };
  const children = sessions.filter(session => session.origin?.parentSessionId === sessionId && !session.archived);
  if (children.length > 0 && decision.confirmed !== true) {
    return { summary: null, confirmationRequired: confirmationFacts(service, parent, children) };
  }
  const updated = await service.setSessionArchived(sessionId, true);
  const childIds = children.length > 0 ? (decision.archiveChildIds ?? []) : [];
  if (updated && childIds.length > 0) await service.archiveFinishedChildren(sessionId, childIds, scope);
  return { summary: updated };
}

function confirmationFacts(
  service: Pick<ChatService, 'childArchiveStatus'>,
  parent: ChatSessionSummary,
  children: ChatSessionSummary[]
): ArchiveConfirmationFacts {
  const facts: ArchiveConfirmationFacts = { parentTitle: parent.title, finished: [], kept: [] };
  for (const child of children) {
    const status = service.childArchiveStatus(child);
    const entry = { id: child.id, title: child.title };
    if (status === 'finished') facts.finished.push(entry);
    else facts.kept.push({ ...entry, status });
  }
  return facts;
}

/** `facts` may come from any host, so a kept child's status is any string it reports. */
export function archiveConfirmationDialog(facts: ArchiveQuestion): ArchiveConfirmation {
  return {
    type: 'question',
    message: `Archive "${facts.parentTitle}"?`,
    detail: [
      'Nothing is deleted. Archived conversations can be restored from the sidebar.',
      ...facts.finished.map(child => `Finished: ${child.title}`),
      ...facts.kept.map(child => `Kept (${child.status}): ${child.title}`),
      'Running sessions and sessions waiting on you will be kept, even if their status changes before you confirm.',
    ].join('\n'),
    buttons: ['Archive', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    ...(facts.finished.length > 0
      ? { checkboxLabel: `Also archive finished sub-sessions (${facts.finished.length})`, checkboxChecked: true }
      : {}),
    noLink: true,
  };
}

/** Parses an untrusted question, shows the dialog, and returns the user's decision; null when the question is invalid or the user cancelled. */
export async function confirmArchiveFromIpc(
  raw: unknown,
  showMessageBox: (options: ArchiveConfirmation) => Promise<ArchiveConfirmationAnswer>
): Promise<ArchiveAnswer | null> {
  const question = archiveConfirmationSchema.safeParse(raw);
  if (!question.success) {
    console.warn('Ignoring an invalid archive confirmation question', question.error);
    return null;
  }
  return archiveDecisionFrom(question.data, await showMessageBox(archiveConfirmationDialog(question.data)));
}

/** The decision a message box answer stands for; null when the user cancelled. */
export function archiveDecisionFrom(facts: ArchiveQuestion, answer: ArchiveConfirmationAnswer): ArchiveAnswer | null {
  if (answer.response !== 0) return null;
  return {
    confirmed: true,
    archiveChildIds: answer.checkboxChecked ? facts.finished.map(child => child.id) : [],
  };
}
