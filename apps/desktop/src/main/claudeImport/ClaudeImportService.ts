import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatAttachmentInput, ChatMessage, ChatSessionSummary } from '@shared/chat';
import type {
  ClaudeCodeImportSettings,
  ClaudeImportKind,
  ClaudeImportResult,
  ClaudeImportState,
  ClaudeRemoveResult,
} from '@shared/claudeImport';
import { IPC_CHANNELS } from '@shared/ipc';
import type { AttachmentStore } from '../chat/AttachmentStore';
import { MAX_ATTACHMENTS_PER_TURN } from '../chat/attachments';
import { ImportScopeChangedError, isForkedImport, type SessionStore } from '../chat/SessionStore';
import { importChatExport, looksLikeClaudeExport } from './ClaudeChatImport';
import {
  countsFor,
  importScopeTag,
  importTranscript,
  listTranscripts,
  matchesFilter,
  needsImport,
  peekTranscript,
  projectsOf,
  runQueue,
  type IndexedTranscript,
} from './ClaudeCodeSync';
import type { PendingAttachment } from './claudeCodeMapper';
import { ImportStateStore, type ClaudeImportSettings, type ScopeImportState } from './ImportStateStore';

/** Low on purpose: an import is background work and must never compete with a reply. */
const IMPORT_CONCURRENCY = 2;
const WATCH_DEBOUNCE_MS = 3000;
const POLL_FALLBACK_MS = 60_000;
/** After the window is up, so the first sync never delays the app's own start. */
const FIRST_SYNC_DELAY_MS = 5000;
const SESSIONS_CHANGED_DEBOUNCE_MS = 500;
const SAVE_EVERY = 25;

export interface ClaudeImportLogger {
  warn(message: string): void;
}

export interface ClaudeImportServiceDeps {
  home: string;
  userData: string;
  store: Pick<SessionStore, 'getImported' | 'putImported'>;
  attachments?: Pick<AttachmentStore, 'add'>;
  /** The signed-in account's session scope, or null while signed out. */
  scopeKey: () => string | null;
  pickModel: () => Promise<string | undefined>;
  listSessions: () => Promise<ChatSessionSummary[]>;
  deleteSession: (id: string) => Promise<void>;
  /** A native dialog; the only way a path reaches the importer from the renderer side. */
  pickPath: (kind: 'folder' | 'export', defaultPath?: string) => Promise<string | null>;
  send: (channel: string, payload: unknown) => void;
  logger: ClaudeImportLogger;
}

export class ClaudeImportService {
  private readonly states: ImportStateStore;
  private transcripts: IndexedTranscript[] = [];
  private codeRun: Promise<void> | null = null;
  private codeRerun = false;
  private chatRunning = false;
  private lastError: string | undefined;
  private codeWatcher: FSWatcher | null = null;
  private codePoll: NodeJS.Timeout | null = null;
  private chatWatcher: FSWatcher | null = null;
  private codeTimer: NodeJS.Timeout | null = null;
  private chatTimer: NodeJS.Timeout | null = null;
  private sessionsTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private removing = false;
  /** Settings writes are read-modify-write; two quick clicks must not lose one of them. */
  private settingsChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ClaudeImportServiceDeps) {
    this.states = new ImportStateStore(join(deps.userData, 'claude-import.json'), join(deps.userData, 'claude-import'));
  }

  defaultSourceFolder(): string {
    return join(this.deps.home, '.claude', 'projects');
  }

  private sourceFolder(settings: ClaudeImportSettings): string {
    return settings.code.sourceFolder ?? this.defaultSourceFolder();
  }

  /** Called once the window is showing. Never awaited by startup. */
  start(): void {
    void this.applyWatchers();
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.autoSync();
    }, FIRST_SYNC_DELAY_MS);
    this.startTimer.unref?.();
  }

  /** The account changed: its imports live in its own scope, so sync that scope. */
  onScopeChanged(): void {
    this.transcripts = [];
    // Restoring the saved sign-in lands here moments after launch; the delayed first sync covers it.
    if (!this.startTimer) void this.autoSync();
    this.pushState();
  }

  private serializeSettings<T>(work: () => Promise<T>): Promise<T> {
    const run = this.settingsChain.then(work, work);
    this.settingsChain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of [this.codeTimer, this.chatTimer, this.sessionsTimer, this.startTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.codePoll) clearInterval(this.codePoll);
    this.codeWatcher?.close();
    this.chatWatcher?.close();
  }

  async state(): Promise<ClaudeImportState> {
    const settings = await this.states.readSettings();
    const scopeKey = this.deps.scopeKey();
    const scope = scopeKey ? await this.states.scope(scopeKey) : null;
    const files = scope?.files ?? {};
    const { forked, ...counts } = countsFor(files, this.transcripts, settings.code);
    return {
      signedIn: !!scopeKey,
      code: {
        settings: settings.code,
        sourceFolder: this.sourceFolder(settings),
        running: !!this.codeRun,
        lastSyncAt: scope?.lastSyncAt ?? null,
        lastSyncMs: scope?.lastSyncMs ?? null,
        counts,
        forked,
        projects: projectsOf(files, this.transcripts),
        ...(this.lastError ? { error: this.lastError } : {}),
      },
      chat: {
        watchFolder: settings.chatWatchFolder,
        running: this.chatRunning,
        lastImport: scope?.lastChatImport ?? null,
      },
    };
  }

  private pushState(): void {
    void this.state().then(
      state => this.deps.send(IPC_CHANNELS.claudeImportStateChanged, state),
      () => undefined
    );
  }

  /** One push for a burst of imported sessions, so the sidebar re-lists once rather than per row. */
  private sessionsChanged(): void {
    if (this.sessionsTimer) return;
    this.sessionsTimer = setTimeout(() => {
      this.sessionsTimer = null;
      this.deps.send(IPC_CHANNELS.claudeImportedSessionsChanged, null);
    }, SESSIONS_CHANGED_DEBOUNCE_MS);
    this.sessionsTimer.unref?.();
  }

  /**
   * Accepts only what Settings can actually offer: booleans, and project cwds the index has
   * seen or the filter already held. Never a path to read.
   */
  setCodeSettings(patch: unknown): Promise<ClaudeImportState> {
    return this.serializeSettings(() => this.applyCodeSettings(patch));
  }

  private async applyCodeSettings(patch: unknown): Promise<ClaudeImportState> {
    const current = await this.states.readSettings();
    const input = (patch && typeof patch === 'object' ? patch : {}) as Partial<ClaudeCodeImportSettings>;
    const next = { ...current.code };
    if (typeof input.enabled === 'boolean') next.enabled = input.enabled;
    if (typeof input.includeSubagents === 'boolean') next.includeSubagents = input.includeSubagents;
    if (input.projects === 'all') next.projects = 'all';
    else if (Array.isArray(input.projects)) {
      const scopeKey = this.deps.scopeKey();
      const known = new Set(
        scopeKey ? projectsOf((await this.states.scope(scopeKey)).files, this.transcripts).map(p => p.cwd) : []
      );
      if (Array.isArray(current.code.projects)) for (const cwd of current.code.projects) known.add(cwd);
      next.projects = input.projects.filter((cwd): cwd is string => typeof cwd === 'string' && known.has(cwd));
    }
    const turnedOn = next.enabled && !current.code.enabled;
    await this.states.writeSettings({ ...current, code: next });
    await this.applyWatchers();
    // With sync off a filter change only waits for the next Sync now: after a Remove, ticking a
    // box must not bring back everything that was just removed.
    const refilter =
      next.includeSubagents !== current.code.includeSubagents || (patch && 'projects' in (patch as object));
    if (turnedOn || (next.enabled && refilter)) void this.syncCode();
    return this.state();
  }

  async pickCodeFolder(reset: boolean): Promise<ClaudeImportState> {
    const before = await this.states.readSettings();
    const folder = reset ? null : await this.deps.pickPath('folder', this.sourceFolder(before));
    if (!reset && !folder) return this.state();
    const enabled = await this.serializeSettings(async () => {
      const current = await this.states.readSettings();
      await this.states.writeSettings({ ...current, code: { ...current.code, sourceFolder: folder, projects: 'all' } });
      return current.code.enabled;
    });
    this.transcripts = [];
    await this.applyWatchers();
    if (enabled) void this.syncCode();
    return this.state();
  }

  async setChatWatchFolder(clear: boolean): Promise<ClaudeImportState> {
    const folder = clear ? null : await this.deps.pickPath('folder', join(this.deps.home, 'Downloads'));
    if (!clear && !folder) return this.state();
    // Only exports that arrive from now on, in every account: whatever is already there was the
    // user's to import by hand.
    await this.serializeSettings(async () => {
      const current = await this.states.readSettings();
      await this.states.writeSettings({ ...current, chatWatchFolder: folder, chatWatchSince: Date.now() });
    });
    await this.applyWatchers();
    return this.state();
  }

  private async autoSync(): Promise<void> {
    const settings = await this.states.readSettings();
    if (settings.code.enabled && this.deps.scopeKey()) await this.syncCode();
  }

  /** Coalesces: a sync asked for while one runs makes that one go round again once. */
  syncCode(): Promise<void> {
    if (this.removing) return Promise.resolve();
    if (this.codeRun) {
      this.codeRerun = true;
      return this.codeRun;
    }
    this.codeRun = (async () => {
      do {
        this.codeRerun = false;
        try {
          await this.runCodeSync();
        } catch (error) {
          // Usually the state file failing to save; the next pass retries from the cursors.
          this.lastError = error instanceof Error ? error.message : String(error);
          this.deps.logger.warn(`CLAUDE IMPORT: sync failed: ${this.lastError}`);
        }
      } while (this.codeRerun && !this.disposed);
    })().finally(() => {
      this.codeRun = null;
      this.pushState();
    });
    this.pushState();
    return this.codeRun;
  }

  private async runCodeSync(): Promise<void> {
    const scopeKey = this.deps.scopeKey();
    if (!scopeKey || this.disposed) return;
    const started = Date.now();
    const settings = await this.states.readSettings();
    const scope = await this.states.scope(scopeKey);
    const root = this.sourceFolder(settings);
    if (!(await isDirectory(root))) {
      this.transcripts = [];
      this.lastError = 'The source folder does not exist.';
      return;
    }
    try {
      this.transcripts = await listTranscripts(root, settings.code.includeSubagents, importScopeTag(scopeKey));
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }

    let changed = false;
    for (const transcript of this.transcripts) {
      const cursor = scope.files[transcript.path];
      if (cursor?.cwd || cursor?.status === 'removed' || cursor?.peekedSize === transcript.size) continue;
      const peeked = await peekTranscript(transcript).catch(() => null);
      scope.files[transcript.path] = {
        ...(cursor ?? { sessionId: transcript.sessionId, size: 0, mtimeMs: 0, offset: 0, status: 'pending' as const }),
        ...(peeked?.cwd ? { cwd: peeked.cwd } : { peekedSize: transcript.size }),
      };
      changed = true;
    }
    if (changed) this.pushState();
    if (await this.pruneOutOfScope(scope, scopeKey, settings.code)) changed = true;

    const queue = this.transcripts
      .filter(transcript => {
        const cursor = scope.files[transcript.path];
        return matchesFilter(cursor?.cwd, settings.code) && needsImport(transcript, cursor);
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let done = 0;
    const pickModel = once(this.deps.pickModel);
    await runQueue(queue, IMPORT_CONCURRENCY, async transcript => {
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) return;
      const previous = scope.files[transcript.path];
      try {
        const cursor = await importTranscript(transcript, previous?.status === 'pending' ? undefined : previous, {
          store: this.deps.store,
          scopeKey,
          storeAttachments: (sessionId, pending) => this.storeAttachments(sessionId, pending),
          pickModel,
          directoryExists: isDirectory,
        });
        scope.files[transcript.path] = { ...cursor, cwd: cursor.cwd ?? previous?.cwd };
        if (cursor.status === 'imported' && (previous?.status !== 'imported' || cursor.offset !== previous.offset)) {
          this.sessionsChanged();
        }
        changed = true;
      } catch (error) {
        // Left as it was: the account it belongs to picks it up on its next sync.
        if (error instanceof ImportScopeChangedError) return;
        changed = true;
        scope.files[transcript.path] = {
          ...(previous ?? { sessionId: transcript.sessionId, offset: 0 }),
          size: transcript.size,
          mtimeMs: transcript.mtimeMs,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
        this.deps.logger.warn(`CLAUDE IMPORT: could not import a transcript: ${String(error)}`);
      }
      if (++done % SAVE_EVERY === 0) {
        await this.states.saveScope(scopeKey);
        this.pushState();
      }
    });

    scope.lastSyncAt = new Date().toISOString();
    scope.lastSyncMs = Date.now() - started;
    // A live Claude Code session wakes this every few seconds; most passes find nothing new.
    if (changed || queue.length > 0) await this.states.saveScope(scopeKey);
  }

  /**
   * A copy whose transcript no longer syncs (a narrowed project filter, or one that ran outside
   * Claude's worktrees) goes, so the sidebar mirrors exactly what syncs. One continued here is
   * the user's own and stays. The cursor goes back to pending, so widening the filter again
   * brings the copy back.
   */
  private async pruneOutOfScope(
    scope: ScopeImportState,
    scopeKey: string,
    settings: ClaudeCodeImportSettings
  ): Promise<boolean> {
    let pruned = false;
    for (const transcript of this.transcripts) {
      const cursor = scope.files[transcript.path];
      if (cursor?.status !== 'imported' || matchesFilter(cursor.cwd, settings)) continue;
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) break;
      const existing = await this.deps.store.getImported(cursor.sessionId, scopeKey).catch(() => null);
      if (existing && isForkedImport(existing)) {
        scope.files[transcript.path] = { ...cursor, status: 'forked' };
      } else {
        if (existing) await this.deps.deleteSession(cursor.sessionId);
        scope.files[transcript.path] = {
          sessionId: cursor.sessionId,
          size: 0,
          mtimeMs: 0,
          offset: 0,
          status: 'pending',
          ...(cursor.cwd ? { cwd: cursor.cwd } : {}),
        };
        this.sessionsChanged();
      }
      pruned = true;
    }
    return pruned;
  }

  async importChatExport(): Promise<ClaudeImportResult> {
    const path = await this.deps.pickPath('export', join(this.deps.home, 'Downloads'));
    if (!path) return { ok: true, state: await this.state() };
    return this.importChatFile(path);
  }

  private async importChatFile(path: string): Promise<ClaudeImportResult> {
    const scopeKey = this.deps.scopeKey();
    if (!scopeKey)
      return { ok: false, error: 'Sign in before importing: imports are saved to your account on this machine.' };
    if (this.chatRunning) return { ok: false, error: 'An import is already running.' };
    if (this.removing) return { ok: false, error: 'Imported sessions are being removed. Try again in a moment.' };
    this.chatRunning = true;
    this.pushState();
    try {
      const scope = await this.states.scope(scopeKey);
      const summary = await importChatExport(path, {
        store: this.deps.store,
        scopeKey,
        storeAttachments: (sessionId, pending) => this.storeAttachments(sessionId, pending),
        pickModel: this.deps.pickModel,
        seen: scope.conversations,
        onProgress: () => this.sessionsChanged(),
      });
      scope.lastChatImport = summary;
      await this.states.saveScope(scopeKey);
      this.sessionsChanged();
      return summary.error && summary.counts.found === 0
        ? { ok: false, error: summary.error }
        : { ok: true, state: await this.state() };
    } finally {
      this.chatRunning = false;
      this.pushState();
    }
  }

  /** Removes only the desktop copies; continued sessions hold the user's own turns and stay. */
  async removeImported(kind: unknown): Promise<ClaudeRemoveResult> {
    if (kind !== 'claude-code' && kind !== 'claude-chat') throw new Error('unknown import source');
    const scopeKey = this.deps.scopeKey();
    if (!scopeKey) return { removed: 0, keptForked: 0 };
    if (this.removing) throw new Error('Imported sessions are already being removed.');
    if (kind === 'claude-chat' && this.chatRunning) throw new Error('Wait for the running import to finish first.');
    this.removing = true;
    try {
      return await this.removeIn(kind, scopeKey);
    } finally {
      this.removing = false;
    }
  }

  private async removeIn(kind: ClaudeImportKind, scopeKey: string): Promise<ClaudeRemoveResult> {
    if (kind === 'claude-code') {
      // Otherwise the next sync would bring every one of them straight back.
      await this.serializeSettings(async () => {
        const settings = await this.states.readSettings();
        await this.states.writeSettings({ ...settings, code: { ...settings.code, enabled: false } });
      });
      await this.applyWatchers();
      await this.codeRun;
    }
    const sessions = (await this.deps.listSessions()).filter(session => session.importOrigin?.kind === kind);
    let removed = 0;
    let keptForked = 0;
    for (const session of sessions) {
      if (session.importOrigin?.forkedAt) {
        keptForked++;
        continue;
      }
      await this.deps.deleteSession(session.id);
      removed++;
    }
    const scope = await this.states.scope(scopeKey);
    if (kind === 'claude-code') {
      for (const [path, cursor] of Object.entries(scope.files)) {
        if (cursor.status !== 'forked')
          scope.files[path] = {
            sessionId: cursor.sessionId,
            size: 0,
            mtimeMs: 0,
            offset: 0,
            status: 'pending',
            ...(cursor.cwd ? { cwd: cursor.cwd } : {}),
          };
      }
    } else {
      scope.conversations = {};
      scope.lastChatImport = null;
    }
    await this.states.saveScope(scopeKey);
    this.sessionsChanged();
    this.pushState();
    return { removed, keptForked };
  }

  private async storeAttachments(
    sessionId: string,
    pending: PendingAttachment[]
  ): Promise<Map<string, ChatMessage['attachments']>> {
    const stored = new Map<string, ChatMessage['attachments']>();
    if (!this.deps.attachments) return stored;
    const byMessage = new Map<string, PendingAttachment[]>();
    for (const item of pending) byMessage.set(item.messageId, [...(byMessage.get(item.messageId) ?? []), item]);
    for (const [messageId, items] of byMessage) {
      const inputs: ChatAttachmentInput[] = items
        .slice(0, MAX_ATTACHMENTS_PER_TURN)
        .map(item => ({ source: 'bytes', name: item.name, mediaType: item.mediaType, data: item.data }));
      const result = await this.deps.attachments.add(sessionId, inputs);
      if (result.attachments.length > 0) stored.set(messageId, result.attachments);
    }
    return stored;
  }

  private async zipsIn(folder: string): Promise<{ path: string; mtimeMs: number }[]> {
    const names = await readdir(folder).catch(() => [] as string[]);
    const zips: { path: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.zip')) continue;
      const path = join(folder, name);
      const info = await stat(path).catch(() => null);
      if (info?.isFile()) zips.push({ path, mtimeMs: info.mtimeMs });
    }
    return zips;
  }

  private async checkWatchedFolder(): Promise<void> {
    const settings = await this.states.readSettings();
    const scopeKey = this.deps.scopeKey();
    if (!settings.chatWatchFolder || !scopeKey || this.chatRunning) return;
    const scope = await this.states.scope(scopeKey);
    for (const zip of await this.zipsIn(settings.chatWatchFolder)) {
      if (scope.watchedSeen[zip.path] === zip.mtimeMs || zip.mtimeMs < settings.chatWatchSince) continue;
      scope.watchedSeen[zip.path] = zip.mtimeMs;
      await this.states.saveScope(scopeKey);
      if (await looksLikeClaudeExport(zip.path)) await this.importChatFile(zip.path);
    }
  }

  /** Brings the watchers in line with the settings; each is throttled and never keeps the app alive. */
  private async applyWatchers(): Promise<void> {
    if (this.disposed) return;
    const settings = await this.states.readSettings();
    this.codeWatcher?.close();
    this.codeWatcher = null;
    if (this.codePoll) clearInterval(this.codePoll);
    this.codePoll = null;
    if (settings.code.enabled) {
      const trigger = () => this.throttle('code', () => void this.autoSync());
      try {
        this.codeWatcher = watch(this.sourceFolder(settings), { recursive: true, persistent: false }, trigger);
        this.codeWatcher.on('error', () => {
          this.codeWatcher?.close();
          this.codeWatcher = null;
          this.startPolling(trigger);
        });
      } catch {
        this.startPolling(trigger);
      }
    }

    this.chatWatcher?.close();
    this.chatWatcher = null;
    if (settings.chatWatchFolder) {
      try {
        this.chatWatcher = watch(settings.chatWatchFolder, { persistent: false }, () =>
          this.throttle('chat', () => void this.checkWatchedFolder())
        );
        this.chatWatcher.on('error', () => undefined);
      } catch (error) {
        this.deps.logger.warn(`CLAUDE IMPORT: cannot watch the export folder: ${String(error)}`);
      }
    }
  }

  private startPolling(trigger: () => void): void {
    if (this.codePoll || this.disposed) return;
    this.codePoll = setInterval(trigger, POLL_FALLBACK_MS);
    this.codePoll.unref?.();
  }

  private throttle(which: 'code' | 'chat', run: () => void): void {
    // A throttle, not a reset-on-every-event debounce: a live Claude Code session appends every
    // second or so, and a timer that restarts on each write would never fire.
    if (which === 'code' ? this.codeTimer : this.chatTimer) return;
    const timer = setTimeout(() => {
      if (which === 'code') this.codeTimer = null;
      else this.chatTimer = null;
      if (!this.disposed) run();
    }, WATCH_DEBOUNCE_MS);
    timer.unref?.();
    if (which === 'code') this.codeTimer = timer;
    else this.chatTimer = timer;
  }
}

/** One lookup per run: a sync while offline would otherwise wait out a timeout per transcript. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => (loading ??= load());
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type { ScopeImportState };
