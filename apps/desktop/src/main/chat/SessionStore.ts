import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type {
  ChatApprovalMode,
  ChatMessage,
  ChatProject,
  ChatSession,
  ChatSessionMode,
  ChatSessionOrigin,
  ChatSessionSummary,
  ChatSpawnSuggestion,
  ReasoningEffortSetting,
} from '@shared/chat';
import { SESSION_TITLE_MAX_LENGTH } from '@shared/chat';
import type { WorkspaceOwner } from '@shared/worktreeRemoval';
import { classifyMessagesOutcome, snippetOf } from '@shared/agentOutcome';
import { isImportedMessageId, normalizeImportOrigin } from '@shared/claudeImport';
import { storedReasoningEffortSetting } from './reasoningEffort';
import type { SessionWritesStore, StoredSessionWrites } from './tools/sessionScripts';
import { assertScopeKey, migrateLegacySessions, sessionScopeKey, type SessionScope } from './sessionScope';

/** Session ids are generated here, but arrive back from the renderer over IPC - see `filePath`. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const UNTITLED = 'New chat';

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * Derive a session title from its first user message, the way the sidebar wants to read:
 * one line, trimmed, ellipsized. Falls back to the placeholder for an empty or blank prompt.
 */
export function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (!oneLine) return UNTITLED;
  if (oneLine.length <= SESSION_TITLE_MAX_LENGTH) return oneLine;
  return `${oneLine.slice(0, SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
}

/**
 * A session file as it is stored, which carries one field the rest of the app never sees.
 *
 * `approvalModeLaunch` stamps a 'full' approval mode with the run of the app that chose it.
 * A file written by an earlier run reads back as 'ask' - see `normalizeApprovalMode`.
 */
type StoredSession = ChatSession & { approvalModeLaunch?: string };

/**
 * The approval mode a stored session actually gets, which is not always the one on disk.
 *
 * 'ask' and 'auto' persist: re-choosing them after every relaunch is exactly the friction this
 * task exists to remove, and both still stop for anything the classifier cannot prove.
 *
 * 'full' does not. It is the mode where nothing stands between a crafted prompt and a read of
 * any file on the machine, and the user's reason for choosing it is almost always a particular
 * piece of work they are sitting and watching. A 'full' that quietly outlived the app it was
 * set in is a different thing from the one they chose, so it reads back as 'ask' - the safest
 * landing, not the next one down. The pill says so on screen the moment they reopen the thread.
 */
function normalizeApprovalMode(value: unknown, stamp: unknown, launchId: string): ChatApprovalMode {
  if (value === 'full') return stamp === launchId ? 'full' : 'ask';
  return value === 'auto' ? 'auto' : 'ask';
}

/** Everything about a new session other than its model. */
export interface CreateOptions {
  /**
   * Fixed at creation rather than settable later for a Chat session, because the working
   * directory it names is what the tools have been running in. A Code session CAN arrive
   * without one and be bound afterwards - that is the one direction `mode` and `project`
   * disagree in, and the chip row is what resolves it.
   */
  project?: ChatProject;
  mode?: ChatSessionMode;
  /**
   * Marks a session the agent spawned. Write-once: the spawn caps are counted off it, so a
   * session that could be re-parented could be walked out of them.
   */
  origin?: ChatSessionOrigin;
  /**
   * What a spawned session inherits from its parent, already clamped by the caller. Absent
   * means the mode the user last picked for themselves - see ApprovalModePreference.
   */
  approvalMode?: ChatApprovalMode;
  /** A spawned session's copy of its parent's session-scoped grants; see ChatSession.grantedDirectories. */
  grantedDirectories?: string[];
  /** A name chosen up front, locked exactly as `rename` locks one. */
  title?: string;
}

/**
 * Sidebar summaries keyed by each file's size and mtime, kept beside the sessions so listing
 * does not re-read and re-parse every transcript on every refresh. Not a `.json` name, so
 * `list` never mistakes it for a session.
 */
const SUMMARY_INDEX = '.summary-index';
const SUMMARY_INDEX_VERSION = 2;
/** Per-session write records (see tools/sessionScripts), in a folder `list` skips as it is not a `.json` name. */
const SESSION_WRITES = '.session-writes';
const LIST_READ_CONCURRENCY = 16;

interface IndexedSummary {
  size: number;
  mtimeMs: number;
  summary: ChatSessionSummary;
}

interface SummaryIndexFile {
  version: number;
  /** The launch defaults baked into every summary; a change invalidates them all. */
  defaults: string;
  entries: Record<string, IndexedSummary>;
}

/** Whether an import wrote its copy, preserved a continuation, or respected conversation/workspace deletion. */
export type PutImportedOutcome = 'written' | 'forked' | 'removed';

/** The guarded removal result, decided while holding the session's write lock. */
export type DeleteImportedOutcome = 'removed' | 'forked' | 'missing';

/** An import ran into an account switch: what it holds belongs to the account it started in. */
export class ImportScopeChangedError extends Error {
  constructor() {
    super('the signed-in account changed during the import');
  }
}

/** True once anything other than the importer has written a message into an imported session. */
export function isForkedImport(session: ChatSession): boolean {
  if (!session.importOrigin) return false;
  return !!session.importOrigin.forkedAt || session.messages.some(message => !isImportedMessageId(message.id));
}

/** Whether a binding's repository and checkout are both still directories; other errors surface. */
async function projectOnDisk(project: ChatProject): Promise<boolean> {
  for (const path of new Set([project.directory, project.workingDirectory])) {
    try {
      if (!(await stat(path)).isDirectory()) return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw error;
    }
  }
  return true;
}

function summarize(session: ChatSession): ChatSessionSummary {
  const { messages, spawnSuggestions: _suggestions, ...summary } = session;
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
  const lastSnippet = lastAssistant ? snippetOf(lastAssistant.content) : '';
  const totalUsdCost = sumUsage(messages, 'usdCost');
  const totalCredits = sumUsage(messages, 'creditsUsed');
  return {
    ...summary,
    messageCount: messages.length,
    ...(lastAssistant ? { lastOutcome: classifyMessagesOutcome(messages) } : {}),
    ...(lastSnippet ? { lastSnippet } : {}),
    ...(totalUsdCost !== undefined ? { totalUsdCost } : {}),
    ...(totalCredits !== undefined ? { totalCredits } : {}),
  };
}

/** Sum of one usage field over every message, or undefined when no message reported it. */
function sumUsage(messages: readonly ChatMessage[], field: 'usdCost' | 'creditsUsed'): number | undefined {
  let total: number | undefined;
  for (const message of messages) {
    const value = message.usage?.[field];
    if (typeof value === 'number') total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Started suggestions kept so a later session_suggestion_update on one can name the child it
 * became; older ones are dropped on the next write.
 */
const MAX_SETTLED_SUGGESTIONS = 20;

function normalizeSuggestions(value: unknown): ChatSpawnSuggestion[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is ChatSpawnSuggestion =>
      !!entry &&
      typeof entry === 'object' &&
      typeof entry.id === 'string' &&
      typeof entry.prompt === 'string' &&
      typeof entry.title === 'string' &&
      (entry.status === 'pending' || entry.status === 'started' || entry.status === 'dismissed')
  );
}

/** What a suggestion list still needs to hold once its outcomes are reported. */
function pruneSuggestions(suggestions: readonly ChatSpawnSuggestion[]): ChatSpawnSuggestion[] {
  const kept = suggestions.filter(entry => entry.status !== 'dismissed' || entry.unreported);
  const settled = kept.filter(entry => entry.status !== 'pending');
  const excess = settled.length - MAX_SETTLED_SUGGESTIONS;
  if (excess <= 0) return kept;
  const dropped = new Set(settled.filter(entry => !entry.unreported).slice(0, excess));
  return kept.filter(entry => !dropped.has(entry));
}

/**
 * A stored project binding, or null when it is not one the tools could be pointed at.
 *
 * `workingDirectory` and `directory` are both required because they are what the tools root
 * themselves at; a partial binding is dropped and the session reads back unbound, which is the
 * safe direction - it loses where it runs, not the conversation.
 */
function normalizeProject(value: unknown): ChatProject | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ChatProject>;
  if (typeof raw.directory !== 'string' || !raw.directory) return null;
  if (typeof raw.workingDirectory !== 'string' || !raw.workingDirectory) return null;
  return {
    directory: raw.directory,
    name: typeof raw.name === 'string' && raw.name ? raw.name : basename(raw.directory),
    branch: typeof raw.branch === 'string' ? raw.branch : '',
    workspace: raw.workspace === true,
    ...(typeof raw.workspaceBranch === 'string' && raw.workspaceBranch ? { workspaceBranch: raw.workspaceBranch } : {}),
    workingDirectory: raw.workingDirectory,
    contextDirectories: Array.isArray(raw.contextDirectories)
      ? raw.contextDirectories.filter((entry): entry is string => typeof entry === 'string')
      : [],
  };
}

/**
 * A stored spawn lineage, or null when the file does not carry a usable one.
 *
 * A partial record reads back as absent, which makes the session look user-created. That is the
 * safe direction for the caps: it can only ever under-count depth for one session, where the
 * alternative - trusting a half-written record - lets a malformed file claim depth 0 forever
 * and turns the nesting cap off.
 */
function normalizeOrigin(value: unknown): ChatSessionOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ChatSessionOrigin>;
  if (typeof raw.parentSessionId !== 'string' || !raw.parentSessionId) return null;
  if (typeof raw.depth !== 'number' || !Number.isFinite(raw.depth) || raw.depth < 1) return null;
  return {
    parentSessionId: raw.parentSessionId,
    depth: Math.floor(raw.depth),
    seedPrompt: typeof raw.seedPrompt === 'string' ? raw.seedPrompt : '',
  };
}

/** Where the store reads the environment-and-account pair it is currently storing under. */
export type SessionScopeProvider = () => SessionScope | null;

/**
 * Where the mode a new conversation starts in is read from and written back to.
 *
 * An interface rather than the class itself so a store can be built without one, which is what
 * a test that does not care about the preference wants: it then starts every session at 'auto'
 * and remembers nothing. See ApprovalModePreference for the live implementation.
 */
export interface ApprovalModeMemory {
  read(): Promise<ChatApprovalMode>;
  record(mode: ChatApprovalMode): Promise<void>;
}

/**
 * Conversations as one JSON file per session, mirroring the CLI's `~/.bike4mind/sessions`.
 *
 * Local because the completion endpoint this client uses is stateless; see @shared/chat.
 *
 * Local is not the same as unscoped, though: one machine reaches several backends and can be
 * signed in to a different account on each. Given a `scope`, the files therefore live one
 * directory down, per environment-and-account pair - see ./sessionScope. Without one they sit
 * directly in `baseDirectory`, which is what a test that does not care builds and what every
 * install before this looked like on disk.
 */
export class SessionStore implements SessionWritesStore {
  /** One preparation - the mkdir, and the legacy migration - per scope directory, not per call. */
  private readonly prepared = new Map<string, Promise<string>>();

  /** The scope directory last resolved, for id-addressed operations only. See `directoryFor`. */
  private lastDirectory: string | null = null;

  /**
   * The tail of each session's read-change-write chain. Every write is a whole-file rewrite, so
   * two overlapping ones lose whichever finished first - and a user starting a suggestion while
   * the reply is still appending is exactly that overlap.
   */
  private readonly writes = new Map<string, Promise<unknown>>();

  /** Import bindings and service cleanup share a lease, always outside the per-session lock. */
  private workspaceBindings: Promise<void> = Promise.resolve();

  withWorkspaceBindings<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.workspaceBindings.then(operation);
    this.workspaceBindings = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Per scope directory; see SUMMARY_INDEX. */
  private readonly summaryIndexes = new Map<string, Promise<Map<string, IndexedSummary>>>();

  constructor(
    private readonly baseDirectory: string,
    private readonly defaultModel: string,
    /**
     * Identifies this run of the app. Only 'full' is scoped to it; a test simulates a relaunch
     * by building a second store over the same directory with a different id.
     */
    private readonly launchId: string = randomUUID(),
    /**
     * Read fresh on every operation rather than captured once, so switching environment or
     * account takes effect on the next call - there is nothing to keep in step, and no window
     * in which the sidebar and the files disagree.
     */
    private readonly scope?: SessionScopeProvider,
    /** Absent means no preference is kept and every new conversation starts at 'auto'. */
    private readonly approvalModes?: ApprovalModeMemory,
    /**
     * The effort a session gets when it has chosen none, which is both a new conversation and
     * every conversation written before the setting existed. Read once per launch from the
     * environment, so a benchmark can move every untouched session without a rebuild.
     */
    private readonly defaultReasoningEffort: ReasoningEffortSetting = 'default'
  ) {}

  /**
   * The directory this call works in, preparing it the first time it is named.
   *
   * With no scope provider this is the base directory and nothing else happens, which is the
   * shape the store had before scoping existed.
   *
   * With one and no current scope, `enumerating` decides. A `list` fails closed and returns
   * nothing: enumeration is the surface that would show one account another's conversations,
   * and "everything in the current scope" has no answer when there is no current scope. An
   * id-addressed call falls back to the scope last resolved, because the only way to be
   * holding a session id is to have listed it while properly scoped, and the call that
   * actually lands here is the tail of a turn still finishing when the user switched
   * environment - that write belongs in the folder its conversation started in, and refusing
   * it would truncate a transcript to protect nothing.
   */
  private async directoryFor(enumerating: boolean): Promise<string | null> {
    if (!this.scope) return this.baseDirectory;

    const scope = this.scope();
    if (!scope) return enumerating ? null : this.lastDirectory;

    // Validated here rather than only where it was derived, for the reason a session id is:
    // this is the sink, and an account id and a URL are both outside input.
    const directory = join(this.baseDirectory, assertScopeKey(sessionScopeKey(scope)));
    const within = relative(resolve(this.baseDirectory), resolve(directory));
    if (!within || within.startsWith('..') || within.includes(sep)) {
      throw new Error('session scope escaped the sessions directory');
    }

    let preparing = this.prepared.get(directory);
    if (!preparing) {
      preparing = this.prepare(directory, !scope.local);
      this.prepared.set(directory, preparing);
    }
    this.lastDirectory = await preparing;
    return this.lastDirectory;
  }

  /**
   * Make a scope's directory and adopt whatever was written before scoping existed.
   *
   * The migration is self-limiting: it moves every loose file out of the base directory, so
   * the scope prepared after this one finds none. Nothing marks it as done, because an empty
   * base directory IS done - a marker could only ever come to disagree with the files.
   */
  private async prepare(directory: string, adoptLegacy: boolean): Promise<string> {
    await mkdir(directory, { recursive: true });
    if (adoptLegacy) await migrateLegacySessions(this.baseDirectory, directory);
    return directory;
  }

  /**
   * A session id becomes a filesystem path component here, so it is validated at the sink
   * rather than only where it enters: ids round-trip through the renderer, and a caller
   * reaching this with `../auth-vault` would otherwise escape the sessions directory.
   */
  private filePath(directory: string, id: string): string {
    if (!isValidSessionId(id)) throw new Error(`invalid session id: ${id}`);
    return join(directory, `${id}.json`);
  }

  /**
   * `model` is what the caller resolved against the server's catalog; omitting it falls back to
   * the build's preferred model, which is the right answer only until that catalog is readable.
   *
   * The rest arrive as named options rather than as three more positionals, because two of
   * them are independently optional and `create(model, undefined, undefined, origin)` is not a
   * call anyone can read.
   */
  async create(model?: string, options: CreateOptions = {}): Promise<ChatSessionSummary> {
    const directory = await this.directoryFor(false);
    // The one operation with nowhere to fall back to: a new conversation has no scope it
    // already belongs to, so there is no folder to put it in until an account is identified.
    if (!directory) throw new Error('cannot start a conversation while no account is signed in');

    const { project, origin, mode = project ? 'code' : 'chat' } = options;
    // A mode the caller named is a spawn inheriting its parent's, already clamped there. Only
    // a conversation the user started themselves reads the preference.
    const approvalMode = options.approvalMode ?? (await this.approvalModes?.read()) ?? 'auto';
    const now = new Date().toISOString();
    const session: ChatSession = {
      id: randomUUID(),
      // Left untitled even for a Code session: the project name is already the group header it
      // sits under, so the row itself is still best named after the first thing asked.
      title: options.title ? deriveTitle(options.title) : UNTITLED,
      ...(options.title ? { titleLocked: true } : {}),
      model: model || this.defaultModel,
      createdAt: now,
      updatedAt: now,
      mode,
      approvalMode,
      reasoningEffort: this.defaultReasoningEffort,
      ...(project && mode === 'code' ? { project } : {}),
      ...(options.grantedDirectories?.length ? { grantedDirectories: [...options.grantedDirectories] } : {}),
      ...(origin ? { origin } : {}),
      messages: [],
    };
    await this.write(directory, session);
    return summarize(session);
  }

  /** Capture identity before an asynchronous operation that must not cross accounts. */
  scopeKey(): string | null {
    if (!this.scope) return 'default';
    const scope = this.scope();
    return scope ? sessionScopeKey(scope) : null;
  }

  async get(id: string): Promise<ChatSession | null> {
    const directory = await this.directoryFor(false);
    return directory ? this.read(directory, id) : null;
  }

  /**
   * The directory an import started under `scopeKey` may use: that account's, and only while it
   * is still the one signed in. Unlike a turn's tail, an import has no claim on the folder last
   * resolved; it would file one account's history under another.
   */
  private async importDirectory(scopeKey: string | undefined): Promise<string> {
    if (this.scope && scopeKey !== undefined) {
      const current = this.scope();
      if (!current || sessionScopeKey(current) !== scopeKey) throw new ImportScopeChangedError();
    }
    const directory = await this.directoryFor(false);
    if (!directory) throw new Error('cannot import while no account is signed in');
    return directory;
  }

  /** `get` for the importer; see importDirectory. */
  async getImported(id: string, scopeKey?: string): Promise<ChatSession | null> {
    return this.read(await this.importDirectory(scopeKey), id);
  }

  /**
   * Newest first. A file that no longer parses is skipped, not fatal - one bad file must not hide the rest.
   *
   * Only files whose size or mtime changed since the last listing are read; see SUMMARY_INDEX.
   */
  async list(): Promise<ChatSessionSummary[]> {
    const directory = await this.directoryFor(true);
    if (!directory) return [];

    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }

    const index = await this.summaryIndex(directory);
    const ids = entries.filter(name => name.endsWith('.json')).map(name => name.slice(0, -'.json'.length));
    let changed = false;
    const sessions: (ChatSessionSummary | null)[] = new Array(ids.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const position = next++;
        const id = ids[position];
        try {
          const info = await stat(this.filePath(directory, id));
          const cached = index.get(id);
          if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
            sessions[position] = cached.summary;
            continue;
          }
          const session = await this.read(directory, id);
          if (!session) continue;
          const summary = summarize(session);
          index.set(id, { size: info.size, mtimeMs: info.mtimeMs, summary });
          changed = true;
          sessions[position] = summary;
        } catch {
          sessions[position] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_READ_CONCURRENCY, ids.length) }, worker));

    const present = new Set(ids);
    for (const id of index.keys()) {
      if (!present.has(id)) {
        index.delete(id);
        changed = true;
      }
    }
    if (changed) await this.saveSummaryIndex(directory, index);

    return sessions
      .filter((session): session is ChatSessionSummary => session !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Only workspace bindings cross account scopes; conversation contents stay private. */
  async workspaceProjectsExcept(sessionId: string): Promise<ChatProject[]> {
    return (await this.workspaceOwnersExcept(sessionId)).flatMap(owner => (owner.project ? [owner.project] : []));
  }

  /** Folder references cross scopes for preservation; titles stay within the current scope. */
  async workspaceOwnersExcept(sessionId: string): Promise<WorkspaceOwner[]> {
    const currentDirectory = await this.directoryFor(false);
    if (!currentDirectory) throw new Error('No conversation scope is available');
    const entries = await readdir(this.baseDirectory, { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new Error('Cannot verify linked conversation storage');
    const directories = [
      this.baseDirectory,
      ...entries
        .filter(entry => entry.isDirectory())
        .map(entry => join(this.baseDirectory, assertScopeKey(entry.name))),
    ];
    const owners: WorkspaceOwner[] = [];
    const directorySchema = z.string().min(1).refine(isAbsolute);
    const schema = z.object({
      project: z
        .object({ contextDirectories: z.array(directorySchema).optional() })
        .passthrough()
        .nullish(),
      grantedDirectories: z.array(directorySchema).optional(),
      title: z.unknown().optional(),
    });
    for (const directory of directories) {
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json')) continue;
        if (directory === currentDirectory && name === `${sessionId}.json`) continue;
        const record = schema.parse(JSON.parse(await readFile(join(directory, name), 'utf8')));
        const project = record.project == null ? undefined : normalizeProject(record.project);
        if (project === null) throw new Error('Cannot verify all conversation workspaces');
        const directories = [
          ...(project ? [project.directory, project.workingDirectory, ...project.contextDirectories] : []),
          ...(record.grantedDirectories ?? []),
        ];
        if (directories.length === 0) continue;
        owners.push({
          ...(project ? { project } : {}),
          directories: [...new Set(directories)],
          title:
            directory === currentDirectory
              ? (typeof record.title === 'string' && record.title.trim()) || UNTITLED
              : 'Another conversation',
        });
      }
    }
    return owners;
  }

  private summaryIndex(directory: string): Promise<Map<string, IndexedSummary>> {
    let loading = this.summaryIndexes.get(directory);
    if (!loading) {
      loading = this.loadSummaryIndex(directory);
      this.summaryIndexes.set(directory, loading);
    }
    return loading;
  }

  private summaryDefaults(): string {
    return JSON.stringify([this.defaultModel, this.defaultReasoningEffort]);
  }

  private async loadSummaryIndex(directory: string): Promise<Map<string, IndexedSummary>> {
    const index = new Map<string, IndexedSummary>();
    try {
      const parsed = JSON.parse(await readFile(join(directory, SUMMARY_INDEX), 'utf8')) as Partial<SummaryIndexFile>;
      if (parsed.version !== SUMMARY_INDEX_VERSION || parsed.defaults !== this.summaryDefaults()) return index;
      for (const [id, entry] of Object.entries(parsed.entries ?? {})) {
        if (!isValidSessionId(id) || !entry?.summary || typeof entry.size !== 'number') continue;
        // 'full' is scoped to the launch that chose it (see normalizeApprovalMode), so a summary
        // carrying it from an earlier run is stale by definition.
        if (entry.summary.approvalMode === 'full') continue;
        index.set(id, entry);
      }
    } catch {
      // Missing or unreadable: every file is read once and the index is rebuilt.
    }
    return index;
  }

  private async saveSummaryIndex(directory: string, index: Map<string, IndexedSummary>): Promise<void> {
    const file: SummaryIndexFile = {
      version: SUMMARY_INDEX_VERSION,
      defaults: this.summaryDefaults(),
      entries: Object.fromEntries(index),
    };
    const path = join(directory, SUMMARY_INDEX);
    // Two listings can save at once; a shared temp name would let one rename the other's half-write.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(file), 'utf8');
      await rename(temporary, path);
    } catch {
      // A cache: failing to save it costs the next listing a re-read, nothing more.
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Name a conversation deliberately, and mark the name as chosen.
   *
   * `titleLocked` is what stops a generated title landing on top of it later - see
   * `applyGeneratedTitle`. It is set here and nowhere else, because this is the only path a
   * name arrives on that somebody meant.
   */
  async rename(id: string, title: string): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      session.title = deriveTitle(title);
      session.titleLocked = true;
      session.updatedAt = new Date().toISOString();
      return true;
    });
  }

  /**
   * Replace the provisional truncation with a generated name, if the session still wants one.
   *
   * The whole race lives here. Generation runs alongside the turn, so the user can rename the
   * row while the request is in flight, and `titleLocked` is read at the moment of the write
   * rather than when the request went out - a chosen name wins however late this arrives.
   * Returns null when it declined, which the caller treats as "nothing to tell the sidebar".
   *
   * Leaves `updatedAt` alone, as pinning does: this says nothing about when the conversation
   * was last talked to, and bumping it would reorder the sidebar behind the user's back.
   */
  async applyGeneratedTitle(id: string, title: string): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (session.titleLocked || session.title === title) return null;
      session.title = title;
      return true;
    });
  }

  /**
   * Pin a conversation to a model. Stored per session rather than as one app-wide setting so
   * reopening a thread resumes the model it was held on - switching model for a new question
   * must not silently rewrite what an old conversation was answered with.
   */
  async setModel(id: string, model: string): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (session.model === model) return false;
      session.model = model;
      session.updatedAt = new Date().toISOString();
      return true;
    });
  }

  async setHistoryEnabled(
    id: string,
    enabled: boolean,
    expectedScope = this.scopeKey(),
    isCurrentOperation: () => boolean = () => true
  ): Promise<ChatSessionSummary | null> {
    return this.mutate(
      id,
      session => {
        if (enabled) session.historyEnabled = true;
        else delete session.historyEnabled;
        return true;
      },
      expectedScope,
      isCurrentOperation
    );
  }

  /**
   * How hard this conversation's model should think, stored beside the model for the same
   * reason: the two are chosen together, and a thread reopened later resumes the pair it was
   * held on rather than whatever the last conversation was set to.
   *
   * Stored even for a model that cannot take one, so switching back to a model that can
   * restores the choice instead of quietly dropping it.
   */
  async setReasoningEffort(id: string, effort: ReasoningEffortSetting): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (session.reasoningEffort === effort) return false;
      session.reasoningEffort = effort;
      session.updatedAt = new Date().toISOString();
      return true;
    });
  }

  /**
   * How much this conversation may do without asking.
   *
   * The ONLY writer of this field, and it is reached from exactly one place: the IPC channel
   * the composer pill calls. No tool, no MCP server and no model output has a path to it -
   * ToolContext carries no mode and HostContext has no setter - because a tool that could
   * raise its own mode would let one crafted prompt grant itself the rest of the disk.
   *
   * Leaves `updatedAt` alone, as pinning does: this says nothing about when the conversation
   * was last talked to, and bumping it would reorder the sidebar behind the user's back.
   */
  async setApprovalMode(id: string, approvalMode: ChatApprovalMode): Promise<ChatSessionSummary | null> {
    const updated = await this.mutate(id, session => {
      session.approvalMode = approvalMode;
      return true;
    });
    // Remembered only for a session that actually took the mode, so a stale id cannot move the
    // preference. Existing conversations keep whatever they were given; this is about the next
    // one. The clamp on 'full' lives in the preference itself.
    if (updated) await this.approvalModes?.record(approvalMode);
    return updated;
  }

  /**
   * Read just the mode, for the gate.
   *
   * Read fresh at each gated call rather than captured when the turn started, so lowering the
   * mode mid-turn takes effect on the very next tool rather than after the reply finishes.
   * A session that has gone reads as 'ask', which fails closed.
   */
  async approvalMode(id: string): Promise<ChatApprovalMode> {
    try {
      return (await this.get(id))?.approvalMode ?? 'ask';
    } catch {
      return 'ask';
    }
  }

  /**
   * Remember the b4m notebook this conversation's generations are filed under. Written once,
   * on the first generation; see `remoteSessionId` in @shared/chat for why it exists at all.
   *
   * Leaves `updatedAt` alone: this is bookkeeping about a turn, not a turn, and bumping it
   * would reorder the sidebar behind the user's back.
   */
  async setRemoteSessionId(id: string, remoteSessionId: string): Promise<void> {
    await this.mutate(id, session => {
      if (session.remoteSessionId === remoteSessionId) return false;
      session.remoteSessionId = remoteSessionId;
      return true;
    });
  }

  /**
   * Pin or unpin a conversation.
   *
   * Leaves `updatedAt` alone: pinning is about where a row sits, and bumping the timestamp
   * would also reorder it within its section, which is not what the user asked for.
   */
  async setPinned(id: string, pinned: boolean): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (pinned) session.pinned = true;
      else delete session.pinned;
      return true;
    });
  }

  /**
   * Archive or restore a conversation.
   *
   * Leaves `updatedAt` alone, as pinning does: this moves a row between sidebar sections and
   * says nothing about when the conversation was last talked to.
   */
  async setArchived(id: string, archived: boolean): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (archived) {
        session.archived = true;
        // Nobody is looking at an archived conversation to start one.
        const kept = (session.spawnSuggestions ?? []).filter(entry => entry.status !== 'pending');
        if (kept.length > 0) session.spawnSuggestions = kept;
        else delete session.spawnSuggestions;
      } else delete session.archived;
      return true;
    });
  }

  async spawnSuggestions(id: string): Promise<ChatSpawnSuggestion[]> {
    return (await this.get(id))?.spawnSuggestions ?? [];
  }

  /**
   * Replace a session's suggestions with what `change` returns, or leave them when it returns
   * null. Resolves to the stored list, or null when nothing was written.
   *
   * Leaves `updatedAt` alone: a card changing says nothing about when the conversation was last
   * talked to.
   */
  async changeSpawnSuggestions(
    id: string,
    change: (current: readonly ChatSpawnSuggestion[]) => ChatSpawnSuggestion[] | null
  ): Promise<ChatSpawnSuggestion[] | null> {
    let stored: ChatSpawnSuggestion[] | null = null;
    await this.mutate(id, session => {
      const next = change(session.spawnSuggestions ?? []);
      if (!next) return null;
      stored = pruneSuggestions(next);
      if (stored.length > 0) session.spawnSuggestions = stored;
      else delete session.spawnSuggestions;
      return true;
    });
    return stored;
  }

  /**
   * Hand every unreported suggestion outcome to the model, once: each is rendered by `describe`
   * onto `messageId`'s `notes`, and marked reported in the same write.
   *
   * Null when there was nothing to report or no such message, and then nothing is written.
   */
  async reportSpawnSuggestions(
    id: string,
    messageId: string,
    describe: (suggestion: ChatSpawnSuggestion) => string
  ): Promise<{ notes: string[]; suggestions: ChatSpawnSuggestion[] } | null> {
    let reported: { notes: string[]; suggestions: ChatSpawnSuggestion[] } | null = null;
    await this.mutate(id, session => {
      const current = session.spawnSuggestions ?? [];
      const unreported = current.filter(entry => entry.unreported);
      const target = session.messages.find(message => message.id === messageId);
      if (unreported.length === 0 || !target) return null;
      const notes = unreported.map(describe);
      target.notes = [...(target.notes ?? []), ...notes];
      const suggestions = pruneSuggestions(
        current.map(entry => {
          if (!entry.unreported) return entry;
          const { unreported: _reported, ...rest } = entry;
          return rest;
        })
      );
      if (suggestions.length > 0) session.spawnSuggestions = suggestions;
      else delete session.spawnSuggestions;
      reported = { notes, suggestions };
      return true;
    });
    return reported;
  }

  /**
   * Ground a Code session. The caller has already resolved `workingDirectory` - this only
   * records the decision, so a worktree that could not be prepared never reaches disk.
   *
   * Keyed on the MODE rather than on an existing project, because the first binding of an
   * unbound Code session comes through here too.
   *
   * Leaves `updatedAt` alone: changing where a conversation is rooted says nothing about when
   * it was last talked to, and bumping it would reorder the sidebar behind the user's back.
   */
  async setProject(id: string, project: ChatProject): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (session.mode !== 'code') return null;
      session.project = project;
      return true;
    });
  }

  /**
   * Change only where a Code session runs, inside the per-session lock. Unlike `setProject`, it
   * keeps the context folders as stored now, so a folder shared while a worktree was being cut
   * is not overwritten by the project snapshot the cut started from.
   */
  async updateProjectWorkspace(
    id: string,
    workspace: Pick<ChatProject, 'workingDirectory'> & Partial<Pick<ChatProject, 'workspaceBranch'>>
  ): Promise<ChatSessionSummary | null> {
    return this.mutate(id, session => {
      if (session.mode !== 'code' || !session.project) return null;
      session.project = { ...session.project, ...workspace };
      return true;
    });
  }

  /** Grant one more folder to a Code session alone. No-op for a Chat session, which has no project. */
  async addContextDirectory(
    id: string,
    directory: string,
    expectedScope = this.scopeKey()
  ): Promise<ChatSessionSummary | null> {
    return this.mutate(
      id,
      session => {
        if (!session.project) return null;
        if (session.project.contextDirectories.includes(directory)) return false;
        session.project.contextDirectories.push(directory);
        return true;
      },
      expectedScope
    );
  }

  /**
   * Grant a folder to this conversation alone, for a session with no project to hold it as a
   * context directory. Reached only from a folder the user shared: a `request_directory` card they clicked, the picker, or `/add-dir`.
   */
  async addGrantedDirectory(
    id: string,
    directory: string,
    expectedScope = this.scopeKey()
  ): Promise<ChatSessionSummary | null> {
    return this.mutate(
      id,
      session => {
        const granted = session.grantedDirectories ?? [];
        if (granted.includes(directory)) return false;
        session.grantedDirectories = [...granted, directory];
        return true;
      },
      expectedScope
    );
  }

  /**
   * Take a folder back from this conversation, whichever list it was granted into: a session's
   * chips draw both, and one remove control must revoke either.
   */
  async removeContextDirectory(
    id: string,
    directory: string,
    expectedScope = this.scopeKey()
  ): Promise<ChatSessionSummary | null> {
    return this.mutate(
      id,
      session => {
        const granted = session.grantedDirectories ?? [];
        if (!granted.includes(directory) && !session.project?.contextDirectories.includes(directory)) return null;
        if (session.project) {
          session.project.contextDirectories = session.project.contextDirectories.filter(entry => entry !== directory);
        }
        const kept = granted.filter(entry => entry !== directory);
        if (kept.length > 0) session.grantedDirectories = kept;
        else delete session.grantedDirectories;
        return true;
      },
      expectedScope
    );
  }

  /**
   * Create or replace a session the Claude importer built, unless the user has continued it
   * here - then it is left exactly as it is and marked forked, so a later sync can never
   * overwrite a desktop turn. Workspace deletion also wins over a binding derived before it.
   */
  async putImported(
    session: ChatSession,
    scopeKey?: string,
    options: { mustExist?: boolean } = {}
  ): Promise<PutImportedOutcome> {
    return this.withWorkspaceBindings(() =>
      this.serialize(session.id, async () => {
        const directory = await this.importDirectory(scopeKey);
        const existing = await this.read(directory, session.id);
        // A deletion while the importer was reading wins over its stale snapshot.
        if (options.mustExist && !existing) return 'removed';
        if (existing && (!existing.importOrigin || isForkedImport(existing))) {
          if (existing.importOrigin && !existing.importOrigin.forkedAt) {
            existing.importOrigin = { ...existing.importOrigin, forkedAt: new Date().toISOString() };
            await this.write(directory, existing);
          }
          return 'forked';
        }
        // The user's own choices on the row outlive a re-sync of its content: anything the import
        // does not set (granted folders, a remote link) rides along, and these it does set lose.
        const kept: Partial<ChatSession> = existing
          ? {
              ...(existing.titleLocked ? { title: existing.title, titleLocked: true } : {}),
              // Same repository only: a project the importer now derives differently is not the user's.
              ...(existing.project && existing.project.directory === session.project?.directory
                ? { project: existing.project }
                : {}),
              model: existing.model,
              approvalMode: existing.approvalMode,
              reasoningEffort: existing.reasoningEffort,
            }
          : {};
        const imported = { ...existing, ...session, ...kept };
        // A carried-over binding whose checkout has since been removed (the normal end of a
        // worktree) yields to the importer's fresh one, which projectFor already checked.
        // Answering 'removed' here would freeze the copy for good: callers read it as deleted.
        if (imported.project && imported.project !== session.project && !(await projectOnDisk(imported.project))) {
          if (session.project) imported.project = session.project;
          else delete imported.project;
        }
        // Only a fresh binding gone under the lease means workspace cleanup won the race.
        if (imported.project && !(await projectOnDisk(imported.project))) return 'removed';
        await this.write(directory, imported);
        return 'written';
      })
    );
  }

  /** Recheck ownership and continuation at the delete sink, in the captured account directory. */
  async deleteImported(id: string, scopeKey: string): Promise<DeleteImportedOutcome> {
    return this.serialize(id, async () => {
      const directory = await this.importDirectory(scopeKey);
      const session = await this.read(directory, id);
      if (!session || !session.importOrigin) return 'missing';
      if (isForkedImport(session)) return 'forked';
      await rm(this.filePath(directory, id), { force: true });
      return 'removed';
    });
  }

  /**
   * Forget the conversation. Deliberately does NOT touch the project directory or its worktree:
   * a worktree can hold uncommitted work, and deleting a chat must never be a way to lose code.
   * Removing one stays a git operation the user performs themselves (`rmworktree <branch>`).
   */
  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      const directory = await this.directoryFor(false);
      if (!directory) return;
      await rm(this.filePath(directory, id), { force: true });
    });
  }

  async loadSessionWrites(id: string): Promise<unknown> {
    const directory = await this.directoryFor(false);
    if (!directory) return null;
    try {
      return JSON.parse(await readFile(this.sessionWritesPath(directory, id), 'utf8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async saveSessionWrites(id: string, writes: StoredSessionWrites): Promise<void> {
    const directory = await this.directoryFor(false);
    if (!directory) return;
    const path = this.sessionWritesPath(directory, id);
    await mkdir(join(directory, SESSION_WRITES), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(writes), 'utf8');
    await rename(temporary, path);
  }

  async deleteSessionWrites(id: string): Promise<void> {
    const directory = await this.directoryFor(false);
    if (directory) await rm(this.sessionWritesPath(directory, id), { force: true });
  }

  private sessionWritesPath(directory: string, id: string): string {
    return join(directory, SESSION_WRITES, basename(this.filePath(directory, id)));
  }

  /**
   * Append a message, titling the session from the first user prompt so the sidebar stops
   * saying "New chat" as soon as there is something to call it.
   */
  async appendMessage(id: string, message: ChatMessage): Promise<ChatSession | null> {
    return this.serialize(id, () => this.appendNow(id, message));
  }

  private async appendNow(id: string, message: ChatMessage): Promise<ChatSession | null> {
    const directory = await this.directoryFor(false);
    if (!directory) return null;
    const session = await this.read(directory, id);
    if (!session) return null;

    // `system` excluded on both sides: a spawned session reporting back is not a prompt, so it
    // neither names the conversation nor counts as the first thing asked in it.
    const isFirstPrompt =
      message.role === 'user' && !message.system && !session.messages.some(m => m.role === 'user' && !m.system);
    // A turn can be an attachment with no words ("look at this" is the screenshot), so the
    // filenames are the only thing left to name the conversation after.
    if (isFirstPrompt && session.title === UNTITLED) {
      const attachmentNames = (message.attachments ?? []).map(attachment => attachment.name).join(', ');
      // A skill turn is named after the INVOCATION. `content` is the expanded body, which is
      // somebody else's instructions - naming the conversation after a sentence from the middle
      // of a SKILL.md tells the user nothing about what they asked for.
      const invocation = message.skill && `/${message.skill.name}${message.skill.args ? ` ${message.skill.args}` : ''}`;
      session.title = deriveTitle(invocation || message.content || attachmentNames);
    }

    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    if (session.importOrigin && !session.importOrigin.forkedAt && !isImportedMessageId(message.id)) {
      session.importOrigin = { ...session.importOrigin, forkedAt: session.updatedAt };
    }
    await this.write(directory, session);
    return session;
  }

  /** Replace an already-appended message, for settling a streamed reply into its final text. */
  async updateMessage(id: string, messageId: string, changes: Partial<ChatMessage>): Promise<ChatSession | null> {
    return this.serialize(id, () => this.updateNow(id, messageId, changes));
  }

  private async updateNow(id: string, messageId: string, changes: Partial<ChatMessage>): Promise<ChatSession | null> {
    const directory = await this.directoryFor(false);
    if (!directory) return null;
    const session = await this.read(directory, id);
    if (!session) return null;

    const target = session.messages.find(m => m.id === messageId);
    if (!target) return session;

    Object.assign(target, changes);
    session.updatedAt = new Date().toISOString();
    await this.write(directory, session);
    return session;
  }

  /**
   * Read-change-write against ONE directory, which is the point of it existing.
   *
   * The scope is resolved once and the read and the write both use it, so an environment
   * switch landing between the two cannot file the session it just read into the folder of the
   * account that is now signed in. `change` returns true to write, false to leave the file
   * alone but still answer with a summary, and null when the session was not one this call
   * applies to at all.
   */
  private async mutate(
    id: string,
    change: (session: ChatSession) => boolean | null,
    expectedScope?: string | null,
    isCurrentOperation: () => boolean = () => true
  ): Promise<ChatSessionSummary | null> {
    return this.serialize(id, async () => {
      if (!isCurrentOperation() || (expectedScope !== undefined && this.scopeKey() !== expectedScope)) return null;
      const directory = await this.directoryFor(false);
      if (!directory) return null;
      const session = await this.read(directory, id);
      if (!session) return null;

      if (!isCurrentOperation() || (expectedScope !== undefined && this.scopeKey() !== expectedScope)) return null;
      const outcome = change(session);
      if (outcome === null) return null;
      if (outcome) await this.write(directory, session);
      return summarize(session);
    });
  }

  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(id) ?? Promise.resolve()).then(work);
    const tail = result.catch(() => undefined);
    this.writes.set(id, tail);
    void tail.then(() => {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    });
    return result;
  }

  private async read(directory: string, id: string): Promise<ChatSession | null> {
    let contents: string;
    try {
      contents = await readFile(this.filePath(directory, id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    return this.parse(contents, id);
  }

  private parse(contents: string, id: string): ChatSession {
    const parsed = JSON.parse(contents) as Partial<ChatSession>;
    const now = new Date().toISOString();
    // Tolerant rather than schema-validated: these are this app's own files, and a field added
    // in a later version must not make an existing conversation unreadable.
    const project = normalizeProject(parsed.project);
    const origin = normalizeOrigin(parsed.origin);
    const importOrigin = normalizeImportOrigin(parsed.importOrigin);
    const suggestions = normalizeSuggestions(parsed.spawnSuggestions);
    // Absolute only: a relative entry would resolve against wherever the app was launched from.
    const grantedDirectories = Array.isArray(parsed.grantedDirectories)
      ? parsed.grantedDirectories.filter((entry): entry is string => typeof entry === 'string' && isAbsolute(entry))
      : [];
    return {
      id: parsed.id ?? id,
      title: parsed.title || UNTITLED,
      model: parsed.model || this.defaultModel,
      createdAt: parsed.createdAt ?? now,
      updatedAt: parsed.updatedAt ?? parsed.createdAt ?? now,
      // Every session written before modes existed is a Chat session, which is why 'chat' is
      // the fallback and not merely the default for new ones. A file claiming 'code' whose
      // project did not survive normalizeProject reads back as an UNBOUND Code session rather
      // than being downgraded: it keeps the chips that can re-point it, and it is safe only
      // because such a session is granted no roots at all - see ChatService.resolveToolScope.
      mode: parsed.mode === 'code' ? 'code' : 'chat',
      approvalMode: normalizeApprovalMode(
        parsed.approvalMode,
        (parsed as StoredSession).approvalModeLaunch,
        this.launchId
      ),
      // A file with no stored effort keeps behaving the way it did before the picker existed:
      // it takes the launch default, which is the environment variable or nothing at all.
      reasoningEffort: storedReasoningEffortSetting(parsed.reasoningEffort) ?? this.defaultReasoningEffort,
      ...(parsed.mode === 'code' && project ? { project } : {}),
      ...(grantedDirectories.length > 0 ? { grantedDirectories } : {}),
      ...(parsed.titleLocked ? { titleLocked: true } : {}),
      ...(parsed.pinned ? { pinned: true } : {}),
      ...(parsed.archived ? { archived: true } : {}),
      ...(parsed.historyEnabled ? { historyEnabled: true } : {}),
      ...(origin ? { origin } : {}),
      ...(importOrigin ? { importOrigin } : {}),
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      ...(typeof parsed.remoteSessionId === 'string' ? { remoteSessionId: parsed.remoteSessionId } : {}),
      ...(suggestions.length > 0 ? { spawnSuggestions: suggestions } : {}),
    };
  }

  private async write(directory: string, session: ChatSession): Promise<void> {
    const path = this.filePath(directory, session.id);
    // Stamped on the way out rather than carried on ChatSession: a 'full' in hand is always
    // one THIS run put there, because a stamp from an earlier run never parses back as 'full'.
    // Any other mode omits the field, so the stamp cannot outlive the choice it describes.
    const record: StoredSession = {
      ...session,
      ...(session.approvalMode === 'full' ? { approvalModeLaunch: this.launchId } : {}),
    };
    await mkdir(directory, { recursive: true });
    // Write-then-rename, as the auth vault does: a crash mid-write would otherwise truncate a
    // conversation into unparseable JSON and lose the whole thread rather than one turn.
    const temporary = `${path}.tmp`;
    await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8');
    await rename(temporary, path);
  }
}
