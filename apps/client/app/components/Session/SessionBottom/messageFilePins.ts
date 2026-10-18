import { isImageAttachment, type IFabFileDocument } from '@bike4mind/common';
import type { ISessionDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';
import { useWorkBenchStore } from '@client/app/contexts/SessionsContext';
import { isOptimisticId } from '@client/app/utils/llm';

/** Ids of the attachments the user scoped to this message only; the server never pins them. */
export const messageOnlyFileIds = (files: PendingMessageFile[]): string[] =>
  files.filter(item => item.scope === 'message').map(item => item.fabFile.id);

/**
 * The sent attachments the server pins to the session (notebook scope, not images - see
 * pinFilesToSessionKnowledge in server/managers/sessionCrud.ts, which must stay in step) that the
 * workbench does not hold yet. Mirrored into the workbench after a send: knowledgeIds writes from
 * this client are full replaces of the workbench, so a pin it never heard of would be undone by
 * the next add or remove.
 */
export const filesPinnedBySend = (
  files: PendingMessageFile[],
  sentIds: string[],
  workBenchFiles: IFabFileDocument[]
): IFabFileDocument[] => {
  const sent = new Set(sentIds);
  const held = new Set(workBenchFiles.map(f => f.id));
  return files
    .filter(item => item.scope === 'notebook' && !isImageAttachment(item.fabFile.mimeType))
    .map(item => item.fabFile)
    .filter(file => sent.has(file.id) && !held.has(file.id));
};

/**
 * Mirrors the server's pin of a landed send into the workbench and the current session copy. Reads
 * the store at call time, so a workbench write made while the send was in flight is kept. The
 * server cannot tell a stale full-list PUT from a deliberate removal, so this mirror is what keeps
 * the pin through this client's next knowledgeIds write.
 */
export const mirrorPinnedMessageFiles = (
  sessionId: string | null | undefined,
  files: PendingMessageFile[],
  sentIds: string[],
  setCurrentSessionRaw: (update: (prev: ISessionDocument | null) => ISessionDocument | null) => void
): void => {
  if (!sessionId || isOptimisticId(sessionId)) return;
  const store = useWorkBenchStore.getState();
  const pinned = filesPinnedBySend(files, sentIds, store.getWorkBenchFiles(sessionId));
  if (pinned.length === 0) return;
  store.setWorkBenchFiles(sessionId, prev => [...prev, ...pinned.filter(f => !prev.some(p => p.id === f.id))]);
  setCurrentSessionRaw(prev =>
    prev && prev.id === sessionId
      ? { ...prev, knowledgeIds: [...new Set([...(prev.knowledgeIds ?? []), ...pinned.map(f => f.id)])] }
      : prev
  );
};
