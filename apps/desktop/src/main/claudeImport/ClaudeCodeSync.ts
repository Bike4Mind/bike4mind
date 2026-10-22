import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { ChatMessage, ChatProject, ChatSession } from '@shared/chat';
import type {
  ChatImportOrigin,
  ClaudeCodeImportSettings,
  ClaudeCodeProject,
  ClaudeImportCounts,
} from '@shared/claudeImport';
import { claudeWorktreeOf } from '@shared/claudeImport';
import { deriveTitle, isForkedImport, type SessionStore } from '../chat/SessionStore';
import {
  applyCodeEvent,
  displayTitle,
  tidyMessages,
  type CodeMapState,
  type PendingAttachment,
} from './claudeCodeMapper';
import type { FileCursor, ScopeImportState } from './ImportStateStore';
import { readHeadAndTail, readJsonlLines } from './jsonlLines';

const HEAD_TAIL_BYTES = 64 * 1024;
/** Lines larger than this are skipped: a single event that size is a pasted binary, not a turn. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const LINES_PER_YIELD = 200;
/**
 * Bumped whenever a transcript maps to a different desktop session (version 2: worktree sessions
 * filed under their repository), so copies made by an older mapping are rebuilt, not resumed.
 */
export const CODE_MAP_VERSION = 2;
/** Decoded images are handed to the attachment store once this many bytes are waiting. */
const PENDING_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** SessionStore's id limit. */
const MAX_SESSION_ID = 64;
const SESSION_FILE = /^[0-9a-f-]{36}\.jsonl$/i;
const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]{1,40})\.jsonl$/;

/** One transcript found on disk. */
export interface IndexedTranscript {
  path: string;
  size: number;
  mtimeMs: number;
  sourceId: string;
  sessionId: string;
  parentSourceId?: string;
}

export interface CodeSyncDeps {
  store: Pick<SessionStore, 'getImported' | 'putImported'>;
  /** The account the run started under; a switch mid-run makes the store refuse the write. */
  scopeKey?: string;
  storeAttachments?: (
    sessionId: string,
    pending: PendingAttachment[]
  ) => Promise<Map<string, ChatMessage['attachments']>>;
  pickModel: () => Promise<string | undefined>;
  directoryExists: (path: string) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Imported ids carry the account, because attachments live in one folder per session id shared
 * by every account on the machine: two accounts importing one transcript would delete and
 * prune each other's files.
 */
export function importScopeTag(scopeKey: string): string {
  return createHash('sha256').update(scopeKey).digest('hex').slice(0, 8);
}

/** A resumed session copies its parent's subagent files, so an agent id is unique only per parent. */
export function codeSessionId(sourceId: string, parentSourceId?: string, scopeTag?: string): string {
  const tag = scopeTag ? `${scopeTag}-` : '';
  if (!parentSourceId) return `cc-${tag}${sourceId}`;
  const readable = `cca-${tag}${parentSourceId}-${sourceId}`;
  if (readable.length <= MAX_SESSION_ID) return readable;
  return `cca-${createHash('sha256').update(`${tag}${parentSourceId}/${sourceId}`).digest('hex').slice(0, 40)}`;
}

/**
 * Every transcript under `root`, by name and stat alone. Never follows anything outside the
 * folder: project folders are read one level down, subagent files one level below a session.
 */
export async function listTranscripts(
  root: string,
  includeSubagents: boolean,
  scopeTag?: string
): Promise<IndexedTranscript[]> {
  const found: IndexedTranscript[] = [];
  let projects: import('node:fs').Dirent[];
  try {
    projects = await readdir(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectPath = join(root, project.name);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && SESSION_FILE.test(entry.name)) {
        const path = join(projectPath, entry.name);
        const sourceId = entry.name.slice(0, -'.jsonl'.length);
        const info = await stat(path).catch(() => null);
        if (info)
          found.push({
            path,
            size: info.size,
            mtimeMs: info.mtimeMs,
            sourceId,
            sessionId: codeSessionId(sourceId, undefined, scopeTag),
          });
      } else if (includeSubagents && entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name)) {
        const folder = join(projectPath, entry.name, 'subagents');
        // lstat: a symlinked folder would lead outside the source folder.
        if (!(await lstat(folder).catch(() => null))?.isDirectory()) continue;
        const agents = await readdir(folder, { withFileTypes: true }).catch(() => []);
        for (const agent of agents) {
          const match = agent.isFile() ? SUBAGENT_FILE.exec(agent.name) : null;
          if (!match) continue;
          const path = join(folder, agent.name);
          const info = await stat(path).catch(() => null);
          if (info) {
            found.push({
              path,
              size: info.size,
              mtimeMs: info.mtimeMs,
              sourceId: match[1],
              sessionId: codeSessionId(match[1], entry.name, scopeTag),
              parentSourceId: entry.name,
            });
          }
        }
      }
    }
    await yieldToLoop();
  }
  const newest = new Map<string, IndexedTranscript>();
  for (const transcript of found) {
    const seen = newest.get(transcript.sessionId);
    if (!seen || transcript.mtimeMs > seen.mtimeMs) newest.set(transcript.sessionId, transcript);
  }
  return [...newest.values()];
}

function parseLines(lines: string[], state: CodeMapState): void {
  const scratch: ChatMessage[] = [];
  for (const line of lines) {
    try {
      applyCodeEvent(JSON.parse(line), scratch, state, [], true);
    } catch {
      // A torn or foreign line says nothing about the session's identity.
    }
  }
}

/** Where a transcript ran, from its first lines only; the index never reads a file whole. */
export async function peekTranscript(transcript: IndexedTranscript): Promise<CodeMapState> {
  const { head, tail } = await readHeadAndTail(transcript.path, transcript.size, HEAD_TAIL_BYTES);
  const state: CodeMapState = {};
  parseLines(head, state);
  parseLines(tail, state);
  return state;
}

/** The project filter names repositories, so all of a repository's worktrees go together. */
export function matchesFilter(cwd: string | undefined, settings: ClaudeCodeImportSettings): boolean {
  const place = claudeWorktreeOf(cwd);
  if (!place) return false;
  return settings.projects === 'all' || settings.projects.includes(place.repository);
}

/**
 * Filed under the repository, as the app's own worktree sessions are, so imports join that
 * project's sidebar group. The recorded branch is what lets a continued session reuse its
 * worktree rather than cut a new one (see resolveWorkspace); once the worktree is gone the
 * repository itself is where it runs.
 */
export async function projectFor(
  cwd: string | undefined,
  gitBranch: string | undefined,
  directoryExists: (path: string) => Promise<boolean>
): Promise<ChatProject | undefined> {
  const place = claudeWorktreeOf(cwd);
  if (!place || !(await directoryExists(place.repository))) return undefined;
  const base = {
    directory: place.repository,
    name: basename(place.repository) || place.repository,
    branch: gitBranch ?? '',
    contextDirectories: [],
  };
  return gitBranch && (await directoryExists(place.worktree))
    ? { ...base, workspace: true, workspaceBranch: gitBranch, workingDirectory: place.worktree }
    : { ...base, workspace: false, workingDirectory: place.repository };
}

export function projectsOf(
  files: Record<string, FileCursor>,
  transcripts: readonly IndexedTranscript[]
): ClaudeCodeProject[] {
  const counts = new Map<string, number>();
  for (const transcript of transcripts) {
    const repository = claudeWorktreeOf(files[transcript.path]?.cwd)?.repository;
    if (repository) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return [...counts]
    .map(([cwd, sessions]) => ({ cwd, name: basename(cwd) || cwd, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.cwd.localeCompare(b.cwd));
}

export function countsFor(
  files: Record<string, FileCursor>,
  transcripts: readonly IndexedTranscript[],
  settings: ClaudeCodeImportSettings
): ClaudeImportCounts & { forked: number } {
  const counts = { found: 0, imported: 0, skipped: 0, failed: 0, forked: 0 };
  for (const transcript of transcripts) {
    const cursor = files[transcript.path];
    if (!matchesFilter(cursor?.cwd, settings)) continue;
    counts.found++;
    if (cursor?.status === 'imported') counts.imported++;
    else if (cursor?.status === 'forked') {
      counts.imported++;
      counts.forked++;
    } else if (cursor?.status === 'failed') counts.failed++;
    else if (cursor) counts.skipped++;
  }
  return counts;
}

/**
 * True after a failed attempt or a file change, while the copy is still ours to write. Not
 * `offset < size`: a torn last line is never consumed, so that would re-run on every sync.
 */
export function needsImport(transcript: IndexedTranscript, cursor: FileCursor | undefined): boolean {
  if (!cursor || cursor.status === 'failed') return true;
  if (cursor.status === 'forked' || cursor.status === 'removed') return false;
  if (cursor.status === 'imported' && cursor.mapVersion !== CODE_MAP_VERSION) return true;
  return cursor.size !== transcript.size || cursor.mtimeMs !== transcript.mtimeMs;
}

/** A resume point sits just past a newline; anything else means the file was rewritten. */
async function startsLineAt(path: string, offset: number): Promise<boolean> {
  if (offset === 0) return true;
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, offset - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } finally {
    await handle.close();
  }
}

/**
 * Narrows `pending` to what still needs storing. A message the desktop copy already holds keeps
 * its files: AttachmentStore writes a new file per add, so re-storing on a rebuild or a
 * re-import would orphan the old ones.
 */
export function carryAttachments(
  messages: ChatMessage[],
  existing: ChatSession | null,
  pending: PendingAttachment[]
): PendingAttachment[] {
  const held = new Map<string, ChatMessage['attachments']>();
  for (const message of existing?.messages ?? [])
    if (message.attachments?.length) held.set(message.id, message.attachments);
  if (held.size === 0) return pending;
  for (const message of messages) {
    const kept = held.get(message.id);
    if (kept && !message.attachments) message.attachments = kept;
  }
  return pending.filter(item => !held.has(item.messageId));
}

async function readSubagentTitle(path: string): Promise<string | undefined> {
  const metaPath = path.replace(/\.jsonl$/, '.meta.json');
  try {
    if (!(await lstat(metaPath)).isFile()) return undefined;
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
      description?: unknown;
    };
    return typeof meta.description === 'string' && meta.description.trim() ? meta.description.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bring one transcript's desktop copy up to date, reading only past the cursor's offset.
 * Returns the new cursor; `state.files` is updated by the caller.
 */
export async function importTranscript(
  transcript: IndexedTranscript,
  previous: FileCursor | undefined,
  deps: CodeSyncDeps
): Promise<FileCursor> {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const existing = await deps.store.getImported(transcript.sessionId, deps.scopeKey);
  if (existing && isForkedImport(existing)) {
    return {
      ...(previous ?? { sessionId: transcript.sessionId, offset: 0 }),
      size: transcript.size,
      mtimeMs: transcript.mtimeMs,
      status: 'forked',
    };
  }
  // Imported once and since deleted by the user: do not bring it back.
  if (previous?.status === 'imported' && !existing) return { ...previous, status: 'removed' };
  // Appending needs the copy the cursor describes; anything else (a truncated or rewritten
  // file, lost bookkeeping) is rebuilt from the top and replaces it.
  const resume =
    previous?.status === 'imported' &&
    previous.mapVersion === CODE_MAP_VERSION &&
    !!existing &&
    previous.offset <= transcript.size &&
    (await startsLineAt(transcript.path, previous.offset));
  let offset = resume ? previous.offset : 0;
  const state: CodeMapState = resume ? { ...(previous.state ?? {}) } : {};

  const messages: ChatMessage[] = resume && existing ? existing.messages : [];
  const pending: PendingAttachment[] = [];
  const flushAttachments = async () => {
    const toStore = carryAttachments(messages, existing, pending.splice(0));
    if (toStore.length === 0 || !deps.storeAttachments) return;
    const stored = await deps.storeAttachments(transcript.sessionId, toStore);
    for (const message of messages) {
      const attachments = stored.get(message.id);
      if (attachments?.length) message.attachments = attachments;
    }
  };
  const subagent = !!transcript.parentSourceId;
  let lines = 0;
  for await (const line of readJsonlLines(transcript.path, offset, MAX_LINE_BYTES)) {
    offset = line.end;
    if (line.text) {
      try {
        applyCodeEvent(JSON.parse(line.text), messages, state, pending, subagent);
      } catch {
        // An unparseable line is skipped like an unknown event; the rest of the file still counts.
      }
      if (pending.reduce((sum, item) => sum + item.data.length, 0) > PENDING_ATTACHMENT_BYTES) await flushAttachments();
    }
    if (++lines % LINES_PER_YIELD === 0) await yieldToLoop();
  }
  // Only the metadata moved (a torn line still being written): nothing to rewrite.
  if (resume && lines === 0) return { ...previous, size: transcript.size, mtimeMs: transcript.mtimeMs };

  // Tidying drops a round that has nothing in it yet; the next line of that API message must
  // then open a fresh round rather than land in the one before it.
  const openRound = messages.at(-1)?.rounds?.at(-1);
  const kept = tidyMessages(messages);
  if (openRound && kept.at(-1)?.rounds?.at(-1) !== openRound) state.lastApiMessageId = undefined;
  const base: FileCursor = {
    sessionId: transcript.sessionId,
    size: transcript.size,
    mtimeMs: transcript.mtimeMs,
    offset,
    status: 'skipped',
    mapVersion: CODE_MAP_VERSION,
    ...(state.cwd ? { cwd: state.cwd } : {}),
    state,
  };
  if (!kept.some(message => !message.system)) return base;

  await flushAttachments();

  const title =
    (subagent ? await readSubagentTitle(transcript.path) : undefined) ?? displayTitle(state) ?? 'Claude Code session';
  const cwd = state.cwd;
  const project = await projectFor(cwd, state.gitBranch, deps.directoryExists);
  const importOrigin: ChatImportOrigin = {
    kind: 'claude-code',
    sourceId: transcript.sourceId,
    sourcePath: transcript.path,
    importedAt: existing?.importOrigin?.importedAt || now,
    sourceUpdatedAt: state.lastTimestamp ?? new Date(transcript.mtimeMs).toISOString(),
    ...(cwd ? { cwd } : {}),
    ...(state.gitBranch ? { gitBranch: state.gitBranch } : {}),
    ...(transcript.parentSourceId ? { parentSourceId: transcript.parentSourceId } : {}),
  };
  const session: ChatSession = {
    id: transcript.sessionId,
    title: deriveTitle(title),
    model: existing?.model ?? (await deps.pickModel()) ?? '',
    createdAt: state.firstTimestamp ?? now,
    updatedAt: state.lastTimestamp ?? now,
    mode: 'code',
    approvalMode: 'ask',
    reasoningEffort: 'default',
    ...(project ? { project } : {}),
    importOrigin,
    messages: kept,
  };
  const outcome = await deps.store.putImported(session, deps.scopeKey, { mustExist: !!existing });
  return { ...base, status: outcome === 'written' ? 'imported' : outcome };
}

/** Run `work` over `items` at most `limit` at a time. */
export async function runQueue<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export type { ScopeImportState };
export { claudeWorktreeOf };
