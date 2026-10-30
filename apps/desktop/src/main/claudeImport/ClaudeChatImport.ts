import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { ChatMessage, ChatSession } from '@shared/chat';
import type { ClaudeChatImportSummary } from '@shared/claudeImport';
import { deriveTitle, ImportScopeChangedError, isForkedImport, type SessionStore } from '../chat/SessionStore';
import type { PendingAttachment } from './claudeCodeMapper';
import { carryAttachments, importScopeTag } from './ClaudeCodeSync';
import { mapConversation } from './claudeChatMapper';
import { streamJsonArray } from './jsonArrayStream';
import { isUnsafeMemberName, listZipMembers, readZipMember, ZipError, type ZipMember } from './zipReader';

/** Uncompressed ceiling for everything read out of one export. */
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;
/** One conversation; past this it is counted as failed rather than parsed. */
export const MAX_CONVERSATION_BYTES = 64 * 1024 * 1024;
const CONVERSATIONS = 'conversations.json';

export interface ChatImportDeps {
  store: Pick<SessionStore, 'getImported' | 'putImported'>;
  /** The account the import started under; see CodeSyncDeps.scopeKey. */
  scopeKey?: string;
  storeAttachments?: (
    sessionId: string,
    pending: PendingAttachment[]
  ) => Promise<Map<string, ChatMessage['attachments']>>;
  pickModel: () => Promise<string | undefined>;
  /** Conversation uuid -> `updated_at` last imported; updated in place. */
  seen: Record<string, string>;
  /** Called every few sessions so the sidebar refreshes in batches rather than per row. */
  onProgress?: () => void;
  now?: () => Date;
}

export function chatSessionId(uuid: string, scopeTag?: string): string {
  return scopeTag ? `cl-${scopeTag}-${uuid}` : `cl-${uuid}`;
}

/**
 * The one member worth reading: `conversations.json` at the root, or one folder down for an
 * archive someone re-zipped. Anything else in the archive is never opened.
 */
export function findConversationsMember(members: readonly ZipMember[]): ZipMember | null {
  const candidates = members.filter(member => {
    const segments = member.name.split('/');
    return segments.at(-1) === CONVERSATIONS && segments.length <= 2;
  });
  const chosen = candidates.find(member => member.name === CONVERSATIONS) ?? candidates[0] ?? null;
  if (chosen && isUnsafeMemberName(chosen.name)) throw new ZipError('the archive has an unsafe file name');
  return chosen;
}

/** True when a zip's directory looks like a claude.ai data export. */
export async function looksLikeClaudeExport(path: string): Promise<boolean> {
  try {
    const members = await listZipMembers(path);
    return (
      !!findConversationsMember(members) && members.some(member => /(^|\/)(users|projects)\.json$/.test(member.name))
    );
  } catch {
    return false;
  }
}

async function* conversationsBytes(path: string): AsyncGenerator<Buffer> {
  if (path.toLowerCase().endsWith('.zip')) {
    const members = await listZipMembers(path);
    if (members.some(member => isUnsafeMemberName(member.name)))
      throw new ZipError('the archive has an unsafe file name');
    const member = findConversationsMember(members);
    if (!member) throw new ZipError('this zip has no conversations.json; is it a claude.ai export?');
    yield* readZipMember(path, member, MAX_EXPORT_BYTES);
    return;
  }
  const info = await stat(path);
  if (info.size > MAX_EXPORT_BYTES) throw new Error('conversations.json is larger than the import limit');
  yield* createReadStream(path) as AsyncIterable<Buffer>;
}

export async function importChatExport(path: string, deps: ChatImportDeps): Promise<ClaudeChatImportSummary> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const counts = { found: 0, imported: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const summary: ClaudeChatImportSummary = { at: now, fileName: basename(path), counts };
  const model = await deps.pickModel();

  try {
    for await (const element of streamJsonArray(conversationsBytes(path), MAX_CONVERSATION_BYTES)) {
      counts.found++;
      try {
        await importOne(element, deps, counts, now, model);
      } catch (error) {
        if (error instanceof ImportScopeChangedError) throw error;
        counts.failed++;
        summary.retryable = true;
      }
      if (counts.found % 25 === 0) {
        deps.onProgress?.();
        await yieldToLoop();
      }
    }
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }
  return summary;
}

async function importOne(
  element: unknown,
  deps: ChatImportDeps,
  counts: ClaudeChatImportSummary['counts'],
  now: string,
  model: string | undefined
): Promise<void> {
  const mapped = element === null ? null : mapConversation(element);
  if (!mapped) {
    counts.failed++;
    return;
  }
  if (mapped.messages.length === 0) {
    counts.skipped++;
    return;
  }
  const id = chatSessionId(mapped.uuid, deps.scopeKey ? importScopeTag(deps.scopeKey) : undefined);
  const existing = await deps.store.getImported(id, deps.scopeKey);
  if (existing && isForkedImport(existing)) {
    counts.skipped++;
    return;
  }
  if (existing && deps.seen[mapped.uuid] === mapped.updatedAt) {
    counts.unchanged++;
    return;
  }
  // Imported before and deleted here since: a later export, watched folder included, must not
  // bring it back. Removing all imported chats clears `seen`.
  if (!existing && deps.seen[mapped.uuid] !== undefined) {
    counts.skipped++;
    return;
  }

  const toStore = carryAttachments(mapped.messages, existing, mapped.attachments);
  if (toStore.length > 0 && deps.storeAttachments) {
    const stored = await deps.storeAttachments(id, toStore);
    for (const message of mapped.messages) {
      const attachments = stored.get(message.id);
      if (attachments?.length) message.attachments = attachments;
    }
  }
  const session: ChatSession = {
    id,
    title: deriveTitle(mapped.title),
    model: existing?.model ?? model ?? '',
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
    mode: 'chat',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    importOrigin: {
      kind: 'claude-chat',
      sourceId: mapped.uuid,
      importedAt: existing?.importOrigin?.importedAt || now,
      sourceUpdatedAt: mapped.updatedAt,
    },
    messages: mapped.messages,
  };
  const outcome = await deps.store.putImported(session, deps.scopeKey, { mustExist: !!existing });
  if (outcome === 'forked' || outcome === 'removed') {
    if (outcome === 'removed') deps.seen[mapped.uuid] = mapped.updatedAt;
    counts.skipped++;
    return;
  }
  deps.seen[mapped.uuid] = mapped.updatedAt;
  if (existing) counts.updated++;
  else counts.imported++;
}
