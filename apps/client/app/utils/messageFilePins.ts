import { isSessionPinnableAttachment, type IFabFileDocument, type ISessionDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';
import { useWorkBenchStore } from '@client/app/contexts/SessionsContext';
import { isOptimisticId } from '@client/app/utils/llm';

type SetCurrentSessionRaw = (update: (prev: ISessionDocument | null) => ISessionDocument | null) => void;

/** Ids of the attachments the user scoped to this message only; the server never pins them. */
export const messageOnlyFileIds = (files: PendingMessageFile[]): string[] =>
  files.filter(item => item.scope === 'message').map(item => item.fabFile.id);

/** The sent attachments the server pins to the session that the workbench does not hold yet. */
export const filesPinnedBySend = (
  files: PendingMessageFile[],
  sentIds: string[],
  workBenchFiles: IFabFileDocument[]
): IFabFileDocument[] => {
  const sent = new Set(sentIds);
  const held = new Set(workBenchFiles.map(f => f.id));
  return files
    .filter(item => item.scope === 'notebook' && isSessionPinnableAttachment(item.fabFile.mimeType))
    .map(item => item.fabFile)
    .filter(file => sent.has(file.id) && !held.has(file.id));
};

/**
 * Mirrors the server's pin of a send into the workbench and the current session copy, BEFORE the
 * send is dispatched. knowledgeIds writes from this client are full replaces of the workbench, and
 * the server cannot tell a stale list from a deliberate removal, so a write that went out without
 * the file would unpin it; mirroring first means every write after the dispatch carries it. Returns
 * the ids it added, for rollbackMirroredPins when the send fails.
 */
export const mirrorPinnedMessageFiles = (
  sessionId: string | null | undefined,
  files: PendingMessageFile[],
  sentIds: string[],
  setCurrentSessionRaw: SetCurrentSessionRaw
): string[] => {
  if (!sessionId || isOptimisticId(sessionId)) return [];
  const store = useWorkBenchStore.getState();
  const pinned = filesPinnedBySend(files, sentIds, store.getWorkBenchFiles(sessionId));
  if (pinned.length === 0) return [];
  store.setWorkBenchFiles(sessionId, prev => [...prev, ...pinned.filter(f => !prev.some(p => p.id === f.id))]);
  setCurrentSessionRaw(prev =>
    prev && prev.id === sessionId
      ? { ...prev, knowledgeIds: [...new Set([...(prev.knowledgeIds ?? []), ...pinned.map(f => f.id)])] }
      : prev
  );
  return pinned.map(f => f.id);
};

/** Undoes mirrorPinnedMessageFiles for a send the server refused, so it pinned nothing. */
export const rollbackMirroredPins = (
  sessionId: string,
  ids: string[],
  setCurrentSessionRaw?: SetCurrentSessionRaw
): void => {
  if (ids.length === 0) return;
  const dropped = new Set(ids);
  useWorkBenchStore.getState().setWorkBenchFiles(sessionId, prev => prev.filter(f => !dropped.has(f.id)));
  setCurrentSessionRaw?.(prev =>
    prev && prev.id === sessionId
      ? { ...prev, knowledgeIds: (prev.knowledgeIds ?? []).filter(id => !dropped.has(id)) }
      : prev
  );
};

// An agent start is acknowledged over the socket (execution_started / agent_error), not by the
// dispatch call, so its mirror is held here per session until the outcome arrives.
const awaitingAgentStart = new Map<string, string[]>();

export const holdMirroredPinsUntilAgentStart = (sessionId: string, ids: string[]): void => {
  if (ids.length > 0) awaitingAgentStart.set(sessionId, [...(awaitingAgentStart.get(sessionId) ?? []), ...ids]);
};

/**
 * Settles the held mirror when the agent start's outcome arrives: kept when it started, rolled back
 * from the workbench when the server refused it before pinning. The current session copy is left
 * alone on a refusal; it only re-adds a file the user scoped to the notebook anyway.
 */
export const settleMirroredPinsOnAgentStart = (sessionId: string | undefined, started: boolean): void => {
  if (!sessionId) return;
  const ids = awaitingAgentStart.get(sessionId);
  awaitingAgentStart.delete(sessionId);
  if (ids && !started) rollbackMirroredPins(sessionId, ids);
};
