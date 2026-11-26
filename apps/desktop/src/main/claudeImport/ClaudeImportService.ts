import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { ChatAttachmentInput, ChatMessage, ChatSessionSummary } from '@shared/chat';
import type {
  ClaudeCodeImportSettings,
  ClaudeImportKind,
  ClaudeImportResult,
  ClaudeImportState,
  ClaudeRemoveResult,
  WebSyncSettings,
} from '@shared/claudeImport';
import { isImportKind, isSyncHintId } from '@shared/claudeImport';
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
  projectFor,
  projectsOf,
  runQueue,
  type IndexedTranscript,
} from './ClaudeCodeSync';
import type { PendingAttachment } from './claudeCodeMapper';
import {
  ImportStateStore,
  type ClaudeImportSettings,
  type FileCursor,
  type ScopeImportState,
} from './ImportStateStore';
import {
  countWebNotebooks,
  describeWebError,
  fetchWebNotebook,
  importNotebook,
  listWebNotebookChanges,
  listWebNotebooks,
  needsWebImport,
  webCounts,
  webSessionId,
  webNotebookWasDeleted,
  type WebApi,
  type WebNotebookChanges,
  type WebNotebookList,
} from './WebSessionSync';
import type { WebNotebook } from './webSessionMapper';

/** Low on purpose: an import is background work and must never compete with a reply. */
const IMPORT_CONCURRENCY = 2;
const WATCH_DEBOUNCE_MS = 3000;
const POLL_FALLBACK_MS = 60_000;
/** After the window is up, so the first sync never delays the app's own start. */
const FIRST_SYNC_DELAY_MS = 5000;
const SESSIONS_CHANGED_DEBOUNCE_MS = 500;
const SAVE_EVERY = 25;
/** Linux mtimes can trail Date.now() slightly, so an export landing right after the watch starts still counts. */
const WATCH_SINCE_SLACK_MS = 2000;
/** Focusing the window syncs web notebooks at most this often (ms). */
const WEB_FOCUS_INTERVAL_MS = 60_000;
/** While a window stays focused, look for new web notebooks this often (ms). There is no push from the web. */
const WEB_POLL_INTERVAL_MS = 3 * 60_000;
/** Each failed poll doubles the wait, up to this many doublings (3 min -> 48 min). */
const WEB_POLL_MAX_BACKOFF_STEPS = 4;
/**
 * Between full lists a web sync reads only the change feed; this often (ms) it lists everything
 * instead, which catches what the feed cannot show, such as a notebook hard-deleted by retention.
 */
const WEB_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
/** Failed notebooks a change-feed run re-reads by id; the rest wait for a later run. */
const WEB_FAILED_RETRIES_PER_RUN = 10;

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
  deleteImported: (id: string, scopeKey: string) => Promise<'removed' | 'forked' | 'missing'>;
  /** A native dialog; the only way a path reaches the importer from the renderer side. */
  pickPath: (kind: 'folder' | 'export', defaultPath?: string) => Promise<string | null>;
  send: (channel: string, payload: unknown) => void;
  logger: ClaudeImportLogger;
  /** The signed-in account's API client, or null while signed out. */
  webApi?: () => WebApi | null;
}

export class ClaudeImportService {
  private readonly states: ImportStateStore;
  private transcripts: IndexedTranscript[] = [];
  private codeRun: Promise<void> | null = null;
  private codeRerun = false;
  private chatRunning = false;
  private lastError: string | undefined;
  private webRun: Promise<void> | null = null;
  private webRerun = false;
  /** Set by Sync now; the next web run lists everything rather than reading the change feed. */
  private webReconcileRequested = false;
  private webError: string | undefined;
  /** When a web run last started or ended: the focus and poll throttles count from the later. */
  private webRanAt = 0;
  private codeWatcher: FSWatcher | null = null;
  private codePoll: NodeJS.Timeout | null = null;
  private chatWatcher: FSWatcher | null = null;
  private chatPoll: NodeJS.Timeout | null = null;
  private checkingWatch = false;
  private codeTimer: NodeJS.Timeout | null = null;
  private chatTimer: NodeJS.Timeout | null = null;
  private sessionsTimer: NodeJS.Timeout | null = null;
  private startTimer: NodeJS.Timeout | null = null;
  private webPollTimer: NodeJS.Timeout | null = null;
  private webPollFailures = 0;
  private windowFocused = false;
  /** Notebooks this run has to read and how many it has read; null between runs. */
  private webProgress: { done: number; total: number } | null = null;
  /** Scopes whose existing copies were brought in line this launch; see tidyImports. */
  private readonly tidied = new Set<string>();
  private disposed = false;
  private removing = false;
  /** For the sidebar hints; looked up once per launch and account, see detectHints. */
  private codeSessions: number | null = null;
  private codeChecked = false;
  private readonly webNotebooks = new Map<string, number>();
  /** When the web count was last tried per account, so a failed one retries on focus but not on every focus. */
  private readonly webCountTriedAt = new Map<string, number>();
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
    this.runBackground(() => this.applyWatchers());
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.runBackground(() => this.autoSync());
      this.runBackground(() => this.autoSyncWeb());
      this.runBackground(() => this.detectHints());
    }, FIRST_SYNC_DELAY_MS);
    this.startTimer.unref?.();
  }

  /** The account changed: its imports live in its own scope, so sync that scope. */
  onScopeChanged(): void {
    this.transcripts = [];
    this.webError = undefined;
    // Restoring the saved sign-in lands here moments after launch; the delayed first sync covers it.
    if (!this.startTimer) {
      this.runBackground(() => this.autoSync());
      this.runBackground(() => this.autoSyncWeb());
      this.runBackground(() => this.detectHints());
    }
    this.pushState();
  }

  /** A window gained focus: catch up with the web, throttled, and never alongside a running sync. */
  onWindowFocus(): void {
    this.windowFocused = true;
    this.scheduleWebPoll();
    this.runBackground(() => this.detectHints());
    if (this.startTimer || this.webRun || Date.now() - this.webRanAt < WEB_FOCUS_INTERVAL_MS) return;
    this.runBackground(() => this.autoSyncWeb());
  }

  /** No window of the app is focused any more (hidden, minimized or in the background): stop polling. */
  onAppBlur(): void {
    this.windowFocused = false;
    if (this.webPollTimer) clearTimeout(this.webPollTimer);
    this.webPollTimer = null;
  }

  /** One pending poll at most, and only while focused; a failed poll backs off, a good one resets. */
  private scheduleWebPoll(): void {
    if (this.webPollTimer || !this.windowFocused || this.disposed) return;
    const delay = WEB_POLL_INTERVAL_MS * 2 ** this.webPollFailures;
    this.webPollTimer = setTimeout(() => {
      this.webPollTimer = null;
      this.runBackground(() => this.pollWeb());
    }, delay);
    this.webPollTimer.unref?.();
  }

  private async pollWeb(): Promise<void> {
    try {
      // A run in flight, or one a focus just started, already covers this tick.
      if (!this.windowFocused || this.webRun || Date.now() - this.webRanAt < WEB_FOCUS_INTERVAL_MS) return;
      await this.autoSyncWeb();
      this.webPollFailures = this.webError ? Math.min(this.webPollFailures + 1, WEB_POLL_MAX_BACKOFF_STEPS) : 0;
    } finally {
      this.scheduleWebPoll();
    }
  }

  private serializeSettings<T>(work: () => Promise<T>): Promise<T> {
    const run = this.settingsChain.then(work, work);
    this.settingsChain = run.catch(() => undefined);
    return run;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of [this.codeTimer, this.chatTimer, this.sessionsTimer, this.startTimer, this.webPollTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.codePoll) clearInterval(this.codePoll);
    if (this.chatPoll) clearInterval(this.chatPoll);
    this.codeWatcher?.close();
    this.chatWatcher?.close();
  }

  async state(): Promise<ClaudeImportState> {
    const settings = await this.states.readSettings();
    const scopeKey = this.deps.scopeKey();
    const scope = scopeKey ? await this.states.scope(scopeKey) : null;
    const files = scope?.files ?? {};
    const { forked, ...counts } = countsFor(files, this.transcripts, settings.code);
    const { forked: webForked, ...webCount } = webCounts(scope?.webNotebooks ?? {});
    return {
      signedIn: !!scopeKey,
      hints: {
        dismissed: scope?.dismissedHints ?? [],
        codeSessions: this.codeSessions,
        webNotebooks: scopeKey ? (this.webNotebooks.get(scopeKey) ?? null) : null,
      },
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
      web: {
        settings: settings.web,
        running: !!this.webRun,
        ...(this.webProgress ? { progress: { ...this.webProgress } } : {}),
        lastSyncAt: scope?.webLastSyncAt ?? null,
        lastSyncMs: scope?.webLastSyncMs ?? null,
        counts: webCount,
        forked: webForked,
        ...(this.webError ? { error: this.webError } : {}),
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

  /** Accepts only the enable toggle from the renderer. */
  setWebSettings(patch: unknown): Promise<ClaudeImportState> {
    return this.serializeSettings(async () => {
      const current = await this.states.readSettings();
      const input = (patch && typeof patch === 'object' ? patch : {}) as Partial<WebSyncSettings>;
      const enabled = typeof input.enabled === 'boolean' ? input.enabled : current.web.enabled;
      await this.states.writeSettings({ ...current, web: { enabled } });
      if (enabled && !current.web.enabled) void this.syncWeb();
      return this.state();
    });
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
      await this.states.writeSettings({
        ...current,
        chatWatchFolder: folder,
        chatWatchSince: Date.now() - WATCH_SINCE_SLACK_MS,
      });
    });
    await this.applyWatchers();
    return this.state();
  }

  async dismissHint(id: unknown): Promise<ClaudeImportState> {
    const scopeKey = this.deps.scopeKey();
    if (scopeKey && isSyncHintId(id)) await this.states.dismissHint(scopeKey, id);
    return this.state();
  }

  /**
   * Feeds the empty-sidebar import card's options: Claude Code sessions counted by file name alone
   * (never read), and one count request to the web. Skipped once that card is dismissed or a sync
   * is on; the Claude Code count runs once per launch, the web count once per account (throttled).
   */
  private async detectHints(): Promise<void> {
    const scopeKey = this.deps.scopeKey();
    if (!scopeKey) return;
    const settings = await this.states.readSettings();
    const dismissed = (await this.states.scope(scopeKey)).dismissedHints;
    const wanted = !dismissed.includes('sidebar-empty');
    if (!this.codeChecked && !settings.code.enabled && !settings.code.sourceFolder && wanted) {
      this.codeChecked = true;
      const transcripts = await listTranscripts(this.defaultSourceFolder(), false);
      this.codeSessions = transcripts.filter(transcript => ranInClaudeWorktree(transcript.path)).length;
    }
    const api = this.deps.webApi?.() ?? null;
    const triedAt = this.webCountTriedAt.get(scopeKey) ?? 0;
    if (
      api &&
      !this.webNotebooks.has(scopeKey) &&
      Date.now() - triedAt >= WEB_FOCUS_INTERVAL_MS &&
      !settings.web.enabled &&
      wanted
    ) {
      this.webCountTriedAt.set(scopeKey, Date.now());
      try {
        this.webNotebooks.set(scopeKey, await countWebNotebooks(api));
      } catch (error) {
        this.deps.logger.warn(`WEB IMPORT: could not count notebooks: ${String(error)}`);
      }
    }
    this.pushState();
  }

  private async autoSync(): Promise<void> {
    const scopeKey = this.deps.scopeKey();
    if (!scopeKey) return;
    if (!this.tidied.has(scopeKey)) {
      this.tidied.add(scopeKey);
      await this.tidyImports(scopeKey).catch(error =>
        this.deps.logger.warn(`CLAUDE IMPORT: could not tidy imported sessions: ${String(error)}`)
      );
    }
    const settings = await this.states.readSettings();
    if (settings.code.enabled) await this.syncCode();
    await this.checkWatchedFolder();
  }

  private async autoSyncWeb(): Promise<void> {
    if (!this.deps.scopeKey() || !(await this.states.readSettings()).web.enabled) return;
    await this.syncWeb();
  }

  /**
   * Coalesces like syncCode. Reads only the signed-in account's notebooks, into its own scope.
   * `reconcile` forces a full list instead of the change feed.
   */
  syncWeb(options: { reconcile?: boolean } = {}): Promise<void> {
    if (this.removing) return Promise.resolve();
    if (options.reconcile) this.webReconcileRequested = true;
    if (this.webRun) {
      this.webRerun = true;
      return this.webRun;
    }
    this.webRun = (async () => {
      do {
        this.webRerun = false;
        this.webRanAt = Date.now();
        try {
          await this.runWebSync();
        } catch (error) {
          this.webError = error instanceof Error ? error.message : String(error);
          this.deps.logger.warn(`WEB IMPORT: sync failed: ${this.webError}`);
        }
      } while (this.webRerun && !this.disposed);
    })().finally(() => {
      this.webRun = null;
      this.webRanAt = Date.now();
      this.webProgress = null;
      this.pushState();
    });
    this.pushState();
    return this.webRun;
  }

  private async runWebSync(): Promise<void> {
    const scopeKey = this.deps.scopeKey();
    const api = this.deps.webApi?.() ?? null;
    if (!scopeKey || !api || this.disposed) return;
    if (!(await this.states.readSettings()).web.enabled) return;
    const started = Date.now();
    const scope = await this.states.scope(scopeKey);
    const reconcile =
      this.webReconcileRequested ||
      scope.webChangeMark === null ||
      scope.webFullListAt === null ||
      started - scope.webFullListAt >= WEB_RECONCILE_INTERVAL_MS;
    this.webReconcileRequested = false;

    const listed = await this.listWeb(api, scope.webChangeMark, reconcile);
    if (!listed) return;
    if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) return;
    if (!(await this.states.readSettings()).web.enabled) return;
    let notebooks = listed.notebooks;
    if (listed.kind === 'full') {
      if (listed.complete) {
        await this.dropWebNotebooks(scope, scopeKey, this.unlistedWebNotebooks(scope, listed.notebooks), id =>
          webNotebookWasDeleted(api, id)
        );
      }
    } else {
      await this.dropWebNotebooks(scope, scopeKey, listed.deletedIds, async () => true);
      notebooks = [...notebooks, ...(await this.retryFailedWebNotebooks(scope, scopeKey, api, notebooks))];
    }

    const tag = importScopeTag(scopeKey);
    const queue = notebooks.filter(notebook => needsWebImport(notebook, scope.webNotebooks[notebook.id]));
    const pickModel = once(this.deps.pickModel);
    let done = 0;
    let finished = true;
    this.webProgress = { done: 0, total: queue.length };
    this.pushState();
    await runQueue(queue, IMPORT_CONCURRENCY, async notebook => {
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) {
        finished = false;
        return;
      }
      if (!(await this.states.readSettings()).web.enabled) {
        finished = false;
        return;
      }
      const previous = scope.webNotebooks[notebook.id];
      const sessionId = webSessionId(notebook.id, tag);
      try {
        const cursor = await importNotebook(notebook, sessionId, previous, {
          api,
          store: this.deps.store,
          deleteImported: this.deps.deleteImported,
          scopeKey,
          pickModel,
        });
        scope.webNotebooks[notebook.id] = cursor;
        if (
          cursor.status === 'imported' ||
          ((previous?.status === 'imported' || previous?.wasImported === true) && cursor.status === 'skipped')
        ) {
          this.sessionsChanged();
        }
      } catch (error) {
        if (error instanceof ImportScopeChangedError) {
          finished = false;
          return;
        }
        scope.webNotebooks[notebook.id] = {
          sessionId,
          version: previous?.version ?? '',
          status: 'failed',
          wasImported: previous?.status === 'imported' || previous?.wasImported === true,
          error: error instanceof Error ? error.message : String(error),
        };
        this.deps.logger.warn(`WEB IMPORT: could not import a notebook: ${String(error)}`);
      }
      done++;
      if (this.webProgress) this.webProgress.done = done;
      if (done % SAVE_EVERY === 0) {
        await this.states.saveScope(scopeKey);
        this.pushState();
      }
    });

    // The mark moves only once every listed notebook has been dealt with: a run cut short reads the
    // same changes again. A notebook that failed keeps its 'failed' cursor and is retried by id.
    if (finished) {
      if (listed.kind === 'full' && listed.complete) {
        scope.webChangeMark = listed.latestChange;
        scope.webFullListAt = started;
      } else if (listed.kind === 'changes' && listed.latestChange) {
        scope.webChangeMark = laterOf(scope.webChangeMark, listed.latestChange);
      }
    }
    scope.webLastSyncAt = new Date().toISOString();
    scope.webLastSyncMs = Date.now() - started;
    await this.states.saveScope(scopeKey);
  }

  /**
   * The change feed since `mark`, or the full list when reconciling, when there is no mark yet, or
   * when the server has no change feed. Null when the listing failed outright; `webError` says why.
   */
  private async listWeb(
    api: WebApi,
    mark: string | null,
    reconcile: boolean
  ): Promise<({ kind: 'changes' } & WebNotebookChanges) | ({ kind: 'full' } & WebNotebookList) | null> {
    try {
      const changes = reconcile || !mark ? null : await listWebNotebookChanges(api, mark);
      if (changes) {
        this.webError = changes.stopReason
          ? `Synced ${changes.notebooks.length} changed Bike4Mind web notebooks; the list ${changes.stopReason}.`
          : undefined;
        if (changes.stopReason) this.deps.logger.warn(`WEB IMPORT: partial change list: ${changes.stopReason}`);
        return { kind: 'changes', ...changes };
      }
      const listed = await listWebNotebooks(api);
      // A partial list still imports, newest first; the error says why some notebooks are missing.
      this.webError = listed.stopReason
        ? `Synced ${listed.notebooks.length} of your Bike4Mind web notebooks; the list ${listed.stopReason}.`
        : undefined;
      if (listed.stopReason) this.deps.logger.warn(`WEB IMPORT: partial notebook list: ${listed.stopReason}`);
      return { kind: 'full', ...listed };
    } catch (error) {
      this.webError = `Could not read your notebooks from Bike4Mind web (${describeWebError(error)}).`;
      this.deps.logger.warn(`WEB IMPORT: could not list notebooks: ${String(error)}`);
      return null;
    }
  }

  /** Imported notebooks a complete full list did not return: deletion candidates. */
  private unlistedWebNotebooks(scope: ScopeImportState, listed: readonly WebNotebook[]): string[] {
    const ids = new Set(listed.map(notebook => notebook.id));
    return Object.keys(scope.webNotebooks).filter(id => !ids.has(id));
  }

  /**
   * The change feed only shows a notebook again when it changes, so a read that failed is retried by
   * id here, a few per run; a full list retries the rest. One found deleted is dropped.
   */
  private async retryFailedWebNotebooks(
    scope: ScopeImportState,
    scopeKey: string,
    api: WebApi,
    listed: readonly WebNotebook[]
  ): Promise<WebNotebook[]> {
    const listedIds = new Set(listed.map(notebook => notebook.id));
    const failed = Object.entries(scope.webNotebooks)
      .filter(([id, cursor]) => cursor.status === 'failed' && !listedIds.has(id))
      .slice(0, WEB_FAILED_RETRIES_PER_RUN)
      .map(([id]) => id);
    const retries: WebNotebook[] = [];
    const deleted: string[] = [];
    for (const id of failed) {
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) break;
      try {
        const notebook = await fetchWebNotebook(api, id);
        if (notebook === 'deleted') deleted.push(id);
        else retries.push(notebook);
      } catch (error) {
        this.deps.logger.warn(`WEB IMPORT: could not re-read a failed notebook: ${describeWebError(error)}`);
      }
    }
    await this.dropWebNotebooks(scope, scopeKey, deleted, async () => true);
    return retries;
  }

  /**
   * A notebook deleted on the web takes its untouched copy with it; a continued one stays.
   * `confirmDeleted` vouches for each candidate: the 404 check for one a full list missed, or
   * nothing for a tombstone the change feed returned.
   */
  private async dropWebNotebooks(
    scope: ScopeImportState,
    scopeKey: string,
    candidates: readonly string[],
    confirmDeleted: (id: string) => Promise<boolean>
  ): Promise<void> {
    for (const id of candidates) {
      const cursor = scope.webNotebooks[id];
      if (!cursor || cursor.status === 'forked') continue;
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) return;
      if (!(await this.states.readSettings()).web.enabled) return;
      if (!(await confirmDeleted(id))) continue;
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) return;
      if (!(await this.states.readSettings()).web.enabled) return;
      const outcome = await this.deps.deleteImported(cursor.sessionId, scopeKey);
      if (outcome === 'forked') {
        scope.webNotebooks[id] = { ...cursor, status: 'forked' };
        continue;
      }
      if (outcome === 'removed') this.sessionsChanged();
      delete scope.webNotebooks[id];
    }
  }

  /**
   * Brings the copies already on disk in line with what syncs now, with sync on or off: ones
   * outside the scope or filter go, and ones an older mapping filed elsewhere move to their
   * repository's project. Reads only the session store, never a transcript, so with sync off
   * nothing new comes in. Continued sessions are the user's and are left as they are.
   */
  private async tidyImports(scopeKey: string): Promise<void> {
    const settings = await this.states.readSettings();
    const scope = await this.states.scope(scopeKey);
    const pathOf = new Map(Object.entries(scope.files).map(([path, cursor]) => [cursor.sessionId, path]));
    let changed = false;
    for (const summary of await this.deps.listSessions()) {
      const origin = summary.importOrigin;
      if (origin?.kind !== 'claude-code' || origin.forkedAt) continue;
      if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) break;
      const path = pathOf.get(summary.id);
      const cursor = path ? scope.files[path] : undefined;
      const wanted =
        matchesFilter(origin.cwd, settings.code) && (settings.code.includeSubagents || !origin.parentSourceId);
      if (!wanted) {
        const outcome = await this.deps.deleteImported(summary.id, scopeKey);
        if (outcome === 'forked') continue;
        if (path && cursor) scope.files[path] = pendingCursor(cursor);
        changed = true;
        continue;
      }
      const project = await projectFor(origin.cwd, origin.gitBranch, isDirectory);
      if (!project || summary.project?.directory === project.directory) continue;
      const session = await this.deps.store.getImported(summary.id, scopeKey);
      if (!session || isForkedImport(session)) continue;
      await this.deps.store.putImported({ ...session, project }, scopeKey);
      changed = true;
    }
    if (!changed) return;
    await this.states.saveScope(scopeKey);
    this.sessionsChanged();
    this.pushState();
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
      const existing = await this.deps.store.getImported(cursor.sessionId, scopeKey);
      if (existing && isForkedImport(existing)) {
        scope.files[transcript.path] = { ...cursor, status: 'forked' };
      } else {
        const outcome = await this.deps.deleteImported(cursor.sessionId, scopeKey);
        scope.files[transcript.path] = outcome === 'forked' ? { ...cursor, status: 'forked' } : pendingCursor(cursor);
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
    if (!isImportKind(kind)) throw new Error('unknown import source');
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
    if (kind === 'b4m-web') {
      await this.serializeSettings(async () => {
        const settings = await this.states.readSettings();
        await this.states.writeSettings({ ...settings, web: { enabled: false } });
      });
      await this.webRun;
    }
    if (this.deps.scopeKey() !== scopeKey) throw new ImportScopeChangedError();
    const sessions = (await this.deps.listSessions()).filter(session => session.importOrigin?.kind === kind);
    if (this.deps.scopeKey() !== scopeKey) throw new ImportScopeChangedError();
    let removed = 0;
    let keptForked = 0;
    const keptSessionIds = new Set<string>();
    for (const session of sessions) {
      if (session.importOrigin?.forkedAt) {
        keptSessionIds.add(session.id);
        keptForked++;
        continue;
      }
      const outcome = await this.deps.deleteImported(session.id, scopeKey);
      if (outcome === 'forked') {
        keptSessionIds.add(session.id);
        keptForked++;
      } else if (outcome === 'removed') removed++;
    }
    const scope = await this.states.scope(scopeKey);
    if (kind === 'claude-code') {
      for (const [path, cursor] of Object.entries(scope.files)) {
        if (keptSessionIds.has(cursor.sessionId)) scope.files[path] = { ...cursor, status: 'forked' };
        else if (cursor.status !== 'forked') scope.files[path] = pendingCursor(cursor);
      }
    } else if (kind === 'b4m-web') {
      for (const [id, cursor] of Object.entries(scope.webNotebooks)) {
        if (keptSessionIds.has(cursor.sessionId) || cursor.status === 'forked') {
          scope.webNotebooks[id] = { ...cursor, status: 'forked' };
        } else delete scope.webNotebooks[id];
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
    const names = await readdir(folder);
    const zips: { path: string; mtimeMs: number }[] = [];
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.zip')) continue;
      const path = join(folder, name);
      try {
        const info = await stat(path);
        if (info.isFile()) zips.push({ path, mtimeMs: info.mtimeMs });
      } catch (error) {
        this.deps.logger.warn(`CLAUDE IMPORT: could not inspect watched export: ${String(error)}`);
      }
    }
    return zips;
  }

  private async checkWatchedFolder(): Promise<void> {
    if (this.checkingWatch || this.disposed || this.removing) return;
    this.checkingWatch = true;
    try {
      const settings = await this.states.readSettings();
      const scopeKey = this.deps.scopeKey();
      if (!settings.chatWatchFolder || !scopeKey || this.chatRunning) return;
      const scope = await this.states.scope(scopeKey);
      for (const zip of await this.zipsIn(settings.chatWatchFolder)) {
        if (this.disposed || this.removing || this.deps.scopeKey() !== scopeKey) break;
        if (scope.watchedSeen[zip.path] === zip.mtimeMs || zip.mtimeMs < settings.chatWatchSince) continue;
        try {
          // A partially downloaded archive or a transient read failure must remain retryable.
          if (!(await looksLikeClaudeExport(zip.path))) continue;
          if (this.deps.scopeKey() !== scopeKey) break;
          const result = await this.importChatFile(zip.path);
          const summary = scope.lastChatImport;
          if (!result.ok || !summary || summary.error || summary.retryable) continue;
          scope.watchedSeen[zip.path] = zip.mtimeMs;
          await this.states.saveScope(scopeKey);
        } catch (error) {
          this.deps.logger.warn(`CLAUDE IMPORT: could not import watched export: ${String(error)}`);
        }
      }
    } finally {
      this.checkingWatch = false;
    }
  }

  private runBackground(work: () => Promise<unknown>): void {
    void work().catch(error => this.deps.logger.warn(`CLAUDE IMPORT: background task failed: ${String(error)}`));
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
      const trigger = () => this.throttle('code', () => this.runBackground(() => this.autoSync()));
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
    if (this.chatPoll) clearInterval(this.chatPoll);
    this.chatPoll = null;
    if (settings.chatWatchFolder) {
      try {
        this.chatWatcher = watch(settings.chatWatchFolder, { persistent: false }, () =>
          this.throttle('chat', () => this.runBackground(() => this.checkWatchedFolder()))
        );
        this.chatWatcher.on('error', error => {
          this.deps.logger.warn(`CLAUDE IMPORT: export folder watcher failed: ${String(error)}`);
        });
      } catch (error) {
        this.deps.logger.warn(`CLAUDE IMPORT: cannot watch the export folder: ${String(error)}`);
      }
      this.chatPoll = setInterval(() => this.runBackground(() => this.checkWatchedFolder()), POLL_FALLBACK_MS);
      this.chatPoll.unref?.();
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

/**
 * Claude Code names a project folder after its cwd with every separator turned into '-', so
 * `<repo>/.claude/worktrees/<name>` shows as `--claude-worktrees-`: the sessions sync takes
 * (see claudeWorktreeOf), told apart without opening a transcript.
 */
function ranInClaudeWorktree(transcriptPath: string): boolean {
  return basename(dirname(transcriptPath)).includes('--claude-worktrees-');
}

/** Read again from the top next time it is in scope: the copy it described is gone. */
function pendingCursor(cursor: FileCursor): FileCursor {
  return {
    sessionId: cursor.sessionId,
    size: 0,
    mtimeMs: 0,
    offset: 0,
    status: 'pending',
    ...(cursor.cwd ? { cwd: cursor.cwd } : {}),
  };
}

/** The later of two ISO timestamps; a mark never moves backwards. */
function laterOf(current: string | null, next: string): string {
  return current && Date.parse(current) > Date.parse(next) ? current : next;
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
