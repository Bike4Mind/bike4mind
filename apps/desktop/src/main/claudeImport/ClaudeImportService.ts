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
import type { SessionStore } from '../chat/SessionStore';
import { importChatExport, looksLikeClaudeExport } from './ClaudeChatImport';
import {
  countsFor,
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
  store: Pick<SessionStore, 'get' | 'putImported'>;
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
    this.startTimer = setTimeout(() => void this.autoSync(), FIRST_SYNC_DELAY_MS);
    this.startTimer.unref?.();
  }

  /** The account changed: its imports live in its own scope, so sync that scope. */
  onScopeChanged(): void {
    this.transcripts = [];
    void this.autoSync();
    this.pushState();
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
  async setCodeSettings(patch: unknown): Promise<ClaudeImportState> {
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
    if (
      turnedOn ||
      next.includeSubagents !== current.code.includeSubagents ||
      (patch && 'projects' in (patch as object))
    ) {
      void this.syncCode();
    }
    return this.state();
  }

  async pickCodeFolder(reset: boolean): Promise<ClaudeImportState> {
    const current = await this.states.readSettings();
    const folder = reset ? null : await this.deps.pickPath('folder', this.sourceFolder(current));
    if (!reset && !folder) return this.state();
    await this.states.writeSettings({ ...current, code: { ...current.code, sourceFolder: folder, projects: 'all' } });
    this.transcripts = [];
    await this.applyWatchers();
    void this.syncCode();
    return this.state();
  }

  async setChatWatchFolder(clear: boolean): Promise<ClaudeImportState> {
    const current = await this.states.readSettings();
    const folder = clear ? null : await this.deps.pickPath('folder', join(this.deps.home, 'Downloads'));
    if (!clear && !folder) return this.state();
    const scopeKey = this.deps.scopeKey();
    if (folder && scopeKey) {
      // Only exports that arrive from now on: whatever is already there was the user's to import.
      const scope = await this.states.scope(scopeKey);
      for (const zip of await this.zipsIn(folder)) scope.watchedSeen[zip.path] = zip.mtimeMs;
      await this.states.saveScope(scopeKey);
    }
    await this.states.writeSettings({ ...current, chatWatchFolder: folder });
    await this.applyWatchers();
    return this.state();
  }

  private async autoSync(): Promise<void> {
    const settings = await this.states.readSettings();
    if (settings.code.enabled && this.deps.scopeKey()) await this.syncCode();
  }

  /** Coalesces: a sync asked for while one runs makes that one go round again once. */
  syncCode(): Promise<void> {
    if (this.codeRun) {
      this.codeRerun = true;
      return this.codeRun;
    }
    this.codeRun = (async () => {
      do {
        this.codeRerun = false;
        await this.runCodeSync();
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
      this.transcripts = await listTranscripts(root, settings.code.includeSubagents);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return;
    }

    for (const transcript of this.transcripts) {
      const cursor = scope.files[transcript.path];
      if (cursor?.cwd || cursor?.status === 'removed') continue;
      const peeked = await peekTranscript(transcript).catch(() => null);
      scope.files[transcript.path] = {
        ...(cursor ?? { sessionId: transcript.sessionId, size: 0, mtimeMs: 0, offset: 0, status: 'pending' as const }),
        ...(peeked?.cwd ? { cwd: peeked.cwd } : {}),
      };
    }
    this.pushState();

    const queue = this.transcripts
      .filter(transcript => {
        const cursor = scope.files[transcript.path];
        return matchesFilter(cursor?.cwd, settings.code) && needsImport(transcript, cursor);
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    let done = 0;
    await runQueue(queue, IMPORT_CONCURRENCY, async transcript => {
      if (this.disposed || this.deps.scopeKey() !== scopeKey) return;
      const previous = scope.files[transcript.path];
      try {
        const cursor = await importTranscript(transcript, previous?.status === 'pending' ? undefined : previous, {
          store: this.deps.store,
          storeAttachments: (sessionId, pending) => this.storeAttachments(sessionId, pending),
          pickModel: this.deps.pickModel,
          directoryExists: isDirectory,
        });
        scope.files[transcript.path] = { ...cursor, cwd: cursor.cwd ?? previous?.cwd };
        if (cursor.status === 'imported') this.sessionsChanged();
      } catch (error) {
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
    await this.states.saveScope(scopeKey);
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
    this.chatRunning = true;
    this.pushState();
    try {
      const scope = await this.states.scope(scopeKey);
      const summary = await importChatExport(path, {
        store: this.deps.store,
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
    if (kind === 'claude-code') {
      const settings = await this.states.readSettings();
      // Otherwise the next sync would bring every one of them straight back.
      await this.states.writeSettings({ ...settings, code: { ...settings.code, enabled: false } });
      await this.applyWatchers();
      await this.codeRun;
    }
    const sessions = (await this.deps.listSessions()).filter(
      session => session.importOrigin?.kind === (kind as ClaudeImportKind)
    );
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
      if (scope.watchedSeen[zip.path] === zip.mtimeMs) continue;
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

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type { ScopeImportState };
