import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import type { ChatMessage, ChatProject, ChatSession } from '@shared/chat';
import type {
  ChatImportOrigin,
  ClaudeCodeImportSettings,
  ClaudeCodeProject,
  ClaudeImportCounts,
} from '@shared/claudeImport';
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
  store: Pick<SessionStore, 'get' | 'putImported'>;
  storeAttachments?: (
    sessionId: string,
    pending: PendingAttachment[]
  ) => Promise<Map<string, ChatMessage['attachments']>>;
  pickModel: () => Promise<string | undefined>;
  directoryExists: (path: string) => Promise<boolean>;
  now?: () => Date;
}

/** A resumed session copies its parent's subagent files, so an agent id is unique only per parent. */
export function codeSessionId(sourceId: string, parentSourceId?: string): string {
  return parentSourceId ? `cca-${parentSourceId}-${sourceId}` : `cc-${sourceId}`;
}

/**
 * Every transcript under `root`, by name and stat alone. Never follows anything outside the
 * folder: project folders are read one level down, subagent files one level below a session.
 */
export async function listTranscripts(root: string, includeSubagents: boolean): Promise<IndexedTranscript[]> {
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
            sessionId: codeSessionId(sourceId),
          });
      } else if (includeSubagents && entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name)) {
        const folder = join(projectPath, entry.name, 'subagents');
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
              sessionId: codeSessionId(match[1], entry.name),
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

export function matchesFilter(cwd: string | undefined, settings: ClaudeCodeImportSettings): boolean {
  if (settings.projects === 'all') return true;
  return !!cwd && settings.projects.includes(cwd);
}

export function projectsOf(
  files: Record<string, FileCursor>,
  transcripts: readonly IndexedTranscript[]
): ClaudeCodeProject[] {
  const counts = new Map<string, number>();
  for (const transcript of transcripts) {
    const cwd = files[transcript.path]?.cwd;
    if (cwd) counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
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

/** True when the file has bytes the cursor has not read, and it is still ours to write. */
export function needsImport(transcript: IndexedTranscript, cursor: FileCursor | undefined): boolean {
  if (!cursor) return true;
  if (cursor.status === 'forked' || cursor.status === 'removed') return false;
  if (cursor.status === 'failed') return cursor.size !== transcript.size || cursor.mtimeMs !== transcript.mtimeMs;
  return cursor.size !== transcript.size || cursor.mtimeMs !== transcript.mtimeMs || cursor.offset < transcript.size;
}

async function readSubagentTitle(path: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')) as {
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
  const existing = await deps.store.get(transcript.sessionId);
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
  const resume = previous?.status === 'imported' && !!existing && previous.offset <= transcript.size;
  let offset = resume ? previous.offset : 0;
  const state: CodeMapState = resume ? { ...(previous.state ?? {}) } : {};

  const messages: ChatMessage[] = resume && existing ? existing.messages : [];
  const pending: PendingAttachment[] = [];
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
    }
    if (++lines % LINES_PER_YIELD === 0) await yieldToLoop();
  }

  const kept = tidyMessages(messages);
  const base: FileCursor = {
    sessionId: transcript.sessionId,
    size: transcript.size,
    mtimeMs: transcript.mtimeMs,
    offset,
    status: 'skipped',
    ...(state.cwd ? { cwd: state.cwd } : {}),
    state,
  };
  if (!kept.some(message => !message.system)) return base;

  if (pending.length > 0 && deps.storeAttachments) {
    const stored = await deps.storeAttachments(transcript.sessionId, pending);
    for (const message of kept) {
      const attachments = stored.get(message.id);
      if (attachments?.length) message.attachments = attachments;
    }
  }

  const title =
    (subagent ? await readSubagentTitle(transcript.path) : undefined) ?? displayTitle(state) ?? 'Claude Code session';
  const cwd = state.cwd;
  const project: ChatProject | undefined =
    cwd && (await deps.directoryExists(cwd))
      ? {
          directory: cwd,
          name: basename(cwd) || cwd,
          branch: state.gitBranch ?? '',
          workspace: false,
          workingDirectory: cwd,
          contextDirectories: [],
        }
      : undefined;
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
  const outcome = await deps.store.putImported(session);
  return { ...base, status: outcome === 'forked' ? 'forked' : 'imported' };
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
