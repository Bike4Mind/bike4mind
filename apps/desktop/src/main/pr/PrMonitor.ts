import type { ChatToolCall } from '@shared/chat';
import {
  parsePullRequestUrl,
  pullRequestFromShell,
  samePullRequest,
  type PrActionResult,
  type PrBarState,
  type PrBinding,
  type PrBindingSource,
  type PrGhStatus,
  type PrOption,
  type PrRef,
  type PrSnapshot,
} from '@shared/pullRequest';
import { GhError } from './gh';
import type { PrBindingStore } from './PrBindingStore';
import type { PrGithub } from './github';
import { shouldAutoArchive } from './autoArchive';
import { POLL_MS, pollDelay } from './pollSchedule';

/** Branches a PR lookup is never made for: a PR "for main" is someone else's fork, not this session's work. */
const UNOWNED_BRANCHES = new Set(['main', 'master', 'develop', 'HEAD']);

/** How long a branch with no PR is believed to still have none. */
const BRANCH_LOOKUP_TTL_MS = 10 * 60_000;

/** gh processes allowed at once across every conversation, so opening many sessions cannot fork a crowd. */
const MAX_CONCURRENT_GH = 2;

const SHELL_TOOLS = new Set(['bash_execute', 'bash_background']);

/** After the agent pushes to a bound PR, checks restart; read again once GitHub has noticed. */
const AFTER_PUSH_MS = 15_000;

/** A missing or signed-out gh is re-tried on opening a conversation at most this often. */
const GH_RETRY_MS = 60_000;

/** The first read of an armed PR nobody has opened is spread over this window, so a launch does not read them all at once. */
const UNOPENED_JITTER_MS = 60_000;

const PUSH_COMMAND = /(^|[\s;&|(])git\s+push\b/;

export interface PrTimers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: PrTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface PrChatHooks {
  /** Where a Code session runs and the branch checked out there; null for anything else. */
  project(sessionId: string): Promise<{ workingDirectory: string; branch: string | null } | null>;
  /** Move the conversation to the sidebar's Archived section. */
  archive(sessionId: string): Promise<void>;
}

export interface PrMonitorLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface PrMonitorDeps {
  store: PrBindingStore;
  github: PrGithub;
  chat: PrChatHooks;
  emit(state: PrBarState): void;
  logger: PrMonitorLogger;
  now?: () => number;
  timers?: PrTimers;
  random?: () => number;
}

interface Live {
  snapshot: PrSnapshot | null;
  error?: string;
  /** The read in flight, so a second ask joins it rather than starting another gh. */
  inflight: Promise<void> | null;
  failures: number;
  timer?: unknown;
}

/**
 * Binds conversations to pull requests, keeps what the bar draws, and decides when to read.
 *
 * Nothing here touches GitHub at launch. Only conversations bound to an OPEN PR are ever read
 * on a timer, at the cadence pollDelay sets; a merged or closed PR, a dismissed bar with nothing
 * armed, and an unopened conversation with nothing armed are never read again on their own.
 */
export class PrMonitor {
  protected readonly live = new Map<string, Live>();
  protected gh: PrGhStatus = 'ok';
  /** Which conversation each window has on screen, keyed by its webContents id. */
  protected readonly onScreen = new Map<number, string>();
  /** Conversations opened since launch. */
  protected readonly opened = new Set<string>();
  private readonly branchLookups = new Map<string, number>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  protected disposed = false;
  /** Set when GitHub reports a rate limit; every read waits until then. */
  private pausedUntil = 0;
  private ghFailedAt = 0;
  private readonly timers: PrTimers;

  constructor(protected readonly deps: PrMonitorDeps) {
    this.timers = deps.timers ?? realTimers;
  }

  /**
   * Arm the slow timer for PRs that have an automation on and are not known to be finished.
   * No read happens here: the first one is a full unopened interval away.
   */
  async start(): Promise<void> {
    const all = await this.deps.store.all();
    for (const [sessionId, binding] of all) {
      if (binding.lastState === 'MERGED' || binding.lastState === 'CLOSED' || !this.armed(binding)) continue;
      const jitter = Math.floor((this.deps.random ?? Math.random)() * UNOPENED_JITTER_MS);
      this.arm(sessionId, POLL_MS.unopenedArmed + jitter);
    }
  }

  protected now(): number {
    return (this.deps.now ?? Date.now)();
  }

  protected entry(sessionId: string): Live {
    let live = this.live.get(sessionId);
    if (!live) {
      live = { snapshot: null, inflight: null, failures: 0 };
      this.live.set(sessionId, live);
    }
    return live;
  }

  protected isOnScreen(sessionId: string): boolean {
    for (const id of this.onScreen.values()) if (id === sessionId) return true;
    return false;
  }

  /**
   * A window now shows `sessionId` (or nothing). Answers with what the bar should draw right
   * away, and starts a read when the one in hand is missing or stale.
   */
  async watch(viewer: number, sessionId: string | null): Promise<PrBarState | null> {
    const previous = this.onScreen.get(viewer);
    if (sessionId) this.onScreen.set(viewer, sessionId);
    else this.onScreen.delete(viewer);
    // The conversation that just left the screen drops to the slower cadence.
    if (previous && previous !== sessionId) void this.schedule(previous);
    if (!sessionId) return null;
    this.opened.add(sessionId);

    if (this.gh !== 'ok' && this.now() - this.ghFailedAt > GH_RETRY_MS) this.gh = 'ok';
    const binding = await this.deps.store.get(sessionId);
    if (!binding) {
      void this.lookUpBranch(sessionId);
      return null;
    }
    if (!binding.dismissed && this.wantsRead(sessionId)) void this.read(sessionId);
    else void this.schedule(sessionId);
    return this.state(sessionId, binding);
  }

  /** A window closed. */
  unwatch(viewer: number): void {
    const previous = this.onScreen.get(viewer);
    this.onScreen.delete(viewer);
    if (previous) void this.schedule(previous);
  }

  /** Whether opening this conversation should start a read: nothing in hand, or it went stale. */
  protected wantsRead(sessionId: string): boolean {
    if (this.gh !== 'ok' || this.now() < this.pausedUntil) return false;
    const live = this.live.get(sessionId);
    if (!live?.snapshot) return true;
    return live.snapshot.state === 'OPEN' && this.now() - live.snapshot.fetchedAt > POLL_MS.onScreenActive;
  }

  /**
   * A tool finished somewhere. Only a shell command that created a PR or pushed a branch with
   * one can bind; see pullRequestFromShell.
   */
  observeToolEnd(sessionId: string, call: ChatToolCall): void {
    if (!SHELL_TOOLS.has(call.name) || call.status !== 'done') return;
    const command = typeof call.input.command === 'string' ? call.input.command : '';
    const ref = pullRequestFromShell(command, call.preview ?? '');
    if (ref) {
      void this.bind(sessionId, ref, 'shell').catch(err => this.deps.logger.warn(`PR: bind failed: ${err}`));
      return;
    }
    if (PUSH_COMMAND.test(command) && this.live.has(sessionId)) this.arm(sessionId, AFTER_PUSH_MS);
  }

  /** The user pasted a URL. Always replaces what was there, unless auto-merge is armed on it. */
  async bindManual(sessionId: string, url: string): Promise<PrActionResult> {
    const ref = parsePullRequestUrl(url);
    if (!ref) return { ok: false, error: 'That is not a GitHub pull request URL.' };
    const current = await this.deps.store.get(sessionId);
    if (current?.autoMerge && !samePullRequest(current, ref)) {
      return { ok: false, error: `Turn off auto-merge on #${current.number} before binding another PR.` };
    }
    await this.bind(sessionId, ref, 'manual');
    return { ok: true };
  }

  /**
   * Bind, or re-bind. The same PR keeps its options and its dismissal (a manual bind lifts that).
   * A different PR replaces it only when nothing is armed on the old one: an automatic detection
   * must not silently abandon an auto-merge the user switched on.
   */
  protected async bind(sessionId: string, ref: PrRef, source: PrBindingSource): Promise<void> {
    const current = await this.deps.store.get(sessionId);
    if (current && samePullRequest(current, ref)) {
      if (source === 'manual' && current.dismissed) {
        await this.deps.store.set(sessionId, { ...current, dismissed: false });
        void this.read(sessionId);
      }
      return;
    }
    if (current && source !== 'manual' && !current.dismissed && this.armed(current)) {
      this.deps.logger.debug(`PR: kept #${current.number} on ${sessionId}; it has automation armed`);
      return;
    }
    const binding: PrBinding = { ...ref, source, boundAt: new Date(this.now()).toISOString() };
    await this.deps.store.set(sessionId, binding);
    this.live.delete(sessionId);
    this.deps.logger.debug(`PR: bound ${sessionId} to ${ref.url} (${source})`);
    await this.publish(sessionId);
    void this.read(sessionId);
  }

  protected armed(binding: PrBinding): boolean {
    return binding.autoFix === true || binding.autoMerge === true || binding.autoArchive === true;
  }

  /** Close the bar for this conversation. Refused while auto-merge is armed, so it is never armed out of sight. */
  async dismiss(sessionId: string): Promise<PrActionResult> {
    const current = await this.deps.store.get(sessionId);
    if (!current) return { ok: true };
    if (current.autoMerge) return { ok: false, error: 'Turn off auto-merge before closing this bar.' };
    await this.deps.store.set(sessionId, { ...current, dismissed: true, autoFix: false, autoArchive: false });
    this.disarm(sessionId);
    await this.publish(sessionId);
    return { ok: true };
  }

  async setOption(sessionId: string, option: PrOption, enabled: boolean): Promise<PrActionResult> {
    const binding = await this.deps.store.get(sessionId);
    if (!binding || binding.dismissed) return { ok: false, error: 'This conversation has no pull request.' };
    if (option !== 'autoArchive') return { ok: false, error: 'Not available yet.' };
    await this.deps.store.set(sessionId, { ...binding, autoArchive: enabled });
    await this.schedule(sessionId);
    await this.publish(sessionId);
    return { ok: true };
  }

  async refresh(sessionId: string): Promise<void> {
    // A refresh is the user's way to say they have installed or signed in to gh.
    if (this.gh !== 'ok') this.gh = 'ok';
    await this.read(sessionId);
  }

  /** The conversation was deleted. */
  async forget(sessionId: string): Promise<void> {
    this.disarm(sessionId);
    this.live.delete(sessionId);
    this.branchLookups.delete(sessionId);
    await this.deps.store.set(sessionId, null);
  }

  dispose(): void {
    this.disposed = true;
    for (const sessionId of this.live.keys()) this.disarm(sessionId);
  }

  /** Read again in `ms`, replacing whatever timer was set. */
  protected arm(sessionId: string, ms: number): void {
    if (this.disposed) return;
    const live = this.entry(sessionId);
    if (live.timer !== undefined) this.timers.clear(live.timer);
    const wait = Math.max(ms, this.pausedUntil - this.now());
    live.timer = this.timers.set(() => {
      live.timer = undefined;
      void this.read(sessionId);
    }, wait);
  }

  protected disarm(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (live?.timer === undefined) return;
    this.timers.clear(live.timer);
    live.timer = undefined;
  }

  /** Set the next read from what is known now, or stop reading. */
  protected async schedule(sessionId: string): Promise<void> {
    const binding = await this.deps.store.get(sessionId);
    const live = this.live.get(sessionId);
    if (!binding || this.gh !== 'ok') {
      this.disarm(sessionId);
      return;
    }
    const snapshot = live?.snapshot;
    const delay = pollDelay({
      state: snapshot?.state ?? binding.lastState,
      dismissed: binding.dismissed === true,
      onScreen: this.isOnScreen(sessionId),
      opened: this.opened.has(sessionId),
      armed: this.armed(binding),
      active:
        !snapshot || snapshot.mergeable === 'UNKNOWN' || snapshot.checks.some(check => check.bucket === 'pending'),
      failures: live?.failures ?? 0,
    });
    if (delay === null) this.disarm(sessionId);
    else this.arm(sessionId, delay);
  }

  /**
   * Binding (b): the Code session's branch already has an open PR. Asked once per conversation
   * per launch (and again after a quiet spell), only when it is opened, never at startup.
   */
  private async lookUpBranch(sessionId: string): Promise<void> {
    const last = this.branchLookups.get(sessionId);
    if (last !== undefined && this.now() - last < BRANCH_LOOKUP_TTL_MS) return;
    if (this.gh !== 'ok') return;
    this.branchLookups.set(sessionId, this.now());
    const project = await this.deps.chat.project(sessionId).catch(() => null);
    const branch = project?.branch;
    if (!project || !branch || UNOWNED_BRANCHES.has(branch)) return;
    try {
      const url = await this.withGh(() => this.deps.github.findOpenForBranch(project.workingDirectory, branch));
      const ref = url ? parsePullRequestUrl(url) : null;
      if (ref && !(await this.deps.store.get(sessionId))) await this.bind(sessionId, ref, 'branch');
    } catch (err) {
      this.noteGhFailure(err);
    }
  }

  /** One gh process per conversation at a time, and a small cap across all of them. */
  protected async withGh<T>(work: () => Promise<T>): Promise<T> {
    // A finished run hands its slot straight to the next waiter, so no third caller can slip
    // in between the release and the waiter waking.
    if (this.running >= MAX_CONCURRENT_GH) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.running += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }

  /** Read the PR now, joining a read already running for this conversation. */
  protected read(sessionId: string): Promise<void> {
    const live = this.entry(sessionId);
    if (live.inflight) return live.inflight;
    live.inflight = this.readOnce(sessionId).finally(() => {
      live.inflight = null;
    });
    void this.publish(sessionId);
    return live.inflight;
  }

  private async readOnce(sessionId: string): Promise<void> {
    const binding = await this.deps.store.get(sessionId);
    if (!binding || this.disposed) return;
    const live = this.entry(sessionId);
    if (this.now() < this.pausedUntil) {
      await this.schedule(sessionId);
      return;
    }
    try {
      const snapshot = await this.withGh(() =>
        this.deps.github.snapshot(binding, { threads: this.wantsThreads(binding) })
      );
      this.gh = 'ok';
      live.snapshot = snapshot;
      live.failures = 0;
      delete live.error;
      await this.afterRead(sessionId, binding, snapshot);
    } catch (err) {
      live.error = this.noteGhFailure(err);
      live.failures += 1;
      if (err instanceof GhError && err.kind === 'rate-limited') {
        this.pausedUntil = this.now() + POLL_MS.rateLimitPause;
        this.deps.logger.warn('PR: GitHub rate limit hit; pausing every PR read');
      }
    }
    await this.schedule(sessionId);
    await this.publish(sessionId);
  }

  protected wantsThreads(_binding: PrBinding): boolean {
    return false;
  }

  protected async afterRead(sessionId: string, binding: PrBinding, snapshot: PrSnapshot): Promise<void> {
    // Re-read, not the copy the read started with: the user may have changed an option while gh ran.
    const current = (await this.deps.store.get(sessionId)) ?? binding;
    const archiving = shouldAutoArchive(current, snapshot.state);
    if (current.lastState !== snapshot.state || archiving) {
      // Recorded before archiving, so a crash in between errs toward not archiving twice.
      await this.deps.store.set(sessionId, {
        ...current,
        lastState: snapshot.state,
        ...(archiving ? { archivedOnClose: true } : {}),
      });
    }
    if (archiving) {
      this.deps.logger.debug(`PR: #${snapshot.number} is ${snapshot.state.toLowerCase()}; archiving ${sessionId}`);
      await this.deps.chat.archive(sessionId).catch(err => this.deps.logger.warn(`PR: archive failed: ${err}`));
    }
  }

  /** Records a missing or signed-out gh as app-wide state, and returns the line to show. */
  protected noteGhFailure(err: unknown): string {
    if (err instanceof GhError) {
      if (err.kind === 'missing') this.gh = 'missing';
      if (err.kind === 'unauthenticated') this.gh = 'unauthenticated';
      if (err.kind === 'missing' || err.kind === 'unauthenticated') this.ghFailedAt = this.now();
      return err.message;
    }
    return err instanceof Error ? err.message : String(err);
  }

  /** What the bar draws. */
  protected async state(sessionId: string, known?: PrBinding | null): Promise<PrBarState> {
    const binding = known === undefined ? await this.deps.store.get(sessionId) : known;
    const live = this.live.get(sessionId);
    const snapshot = live?.snapshot ?? null;
    return {
      sessionId,
      binding: binding && !binding.dismissed ? binding : null,
      snapshot: snapshot ? withoutThreads(snapshot) : null,
      gh: this.gh,
      ...(live?.error ? { error: live.error } : {}),
      refreshing: !!live?.inflight,
      autoMerge: { mode: null },
      autoFix: { status: 'off', attempts: binding?.autoFixAttempts ?? 0, max: 0 },
    };
  }

  protected async publish(sessionId: string): Promise<void> {
    if (this.disposed) return;
    this.deps.emit(await this.state(sessionId));
  }
}

function withoutThreads(snapshot: PrSnapshot): Omit<PrSnapshot, 'threads'> {
  const { threads: _threads, ...rest } = snapshot;
  return rest;
}
