import { isImageAttachment, type IFabFileDocument } from '@bike4mind/common';
import type { PendingMessageFile } from '@client/app/hooks/useSessionLayout';

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
