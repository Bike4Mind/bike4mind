import { foldActivity, type AgentActivity } from '@shared/agentActivity';
import type {
  ChatApprovalAnswer,
  ChatMessage,
  ChatSessionStatus,
  ChatSessionStatusEvent,
  ChatSessionSummary,
  ChatStreamEvent,
  ChatToolCall,
} from '@shared/chat';
import { pendingCallsIn } from '@shared/needsYou';
import { EMPTY_WATCH_SNAPSHOT, buildWatchSnapshot, type WatchDecision, type WatchSnapshot } from '@shared/watch';

export type WatchSources = {
  /** The signed-in scope's sessions, as the needs-you monitor reads them. */
  listSessions(): Promise<ChatSessionSummary[]>;
  /** Every session's current status: the snapshot `chat:get-session-statuses` serves. */
  sessionStatuses(): ChatSessionStatusEvent[];
  sessionMessages(sessionId: string): Promise<readonly ChatMessage[]>;
  /** The approval gate's own resolve: the one `chat:respond-to-approval` calls. */
  resolveApproval(approvalId: string, answer: ChatApprovalAnswer): unknown;
  warn(message: string): void;
  now?(): number;
};

/** Stream deltas arrive per token; the activity text only needs to keep up with a reader. */
export const STREAM_THROTTLE_MS = 250;

/**
 * Main's live summary of every orchestration, for the menu-bar item and the mini Tavern. It reads
 * the same status feed as the needs-you monitor (main/index.ts hands both the chat module's
 * `observeSessionStatus`), so the tray and the dock badge always count the same sessions.
 */
export class WatchService {
  private sessions: ChatSessionSummary[] = [];
  private readonly statuses = new Map<string, ChatSessionStatus>();
  private activity: ReadonlyMap<string, AgentActivity> = new Map();
  private readonly pending = new Map<string, ChatToolCall[]>();
  private readonly needsYouSince = new Map<string, number>();
  private readonly unacknowledgedDone = new Set<string>();
  private readonly busyRoots = new Set<string>();
  // Sessions seen busy since the last rebuild, so a turn that starts and ends before the queued
  // rebuild runs still counts as having worked.
  private readonly busySinceRebuild = new Set<string>();
  private current: WatchSnapshot = EMPTY_WATCH_SNAPSHOT;
  private currentKey = JSON.stringify(EMPTY_WATCH_SNAPSHOT);
  private readonly listeners = new Set<(snapshot: WatchSnapshot) => void>();
  // Serialised so each rebuild reads the session list after the status that triggered it.
  private queue: Promise<void> = Promise.resolve();
  private streamTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly sources: WatchSources) {}

  /** Seeds the statuses that were set before the service existed, then builds the first snapshot. */
  start(): void {
    for (const event of this.sources.sessionStatuses()) this.applyStatus(event);
    this.enqueue(async () => {
      await this.reloadSessions();
      await Promise.all(
        [...this.statuses].filter(([, status]) => status === 'needs-action').map(([id]) => this.readPending(id))
      );
      this.rebuild();
    });
  }

  observeStatus(event: ChatSessionStatusEvent): void {
    const previous = this.statuses.get(event.sessionId);
    this.applyStatus(event);
    const waitingChanged = (previous === 'needs-action') !== (event.status === 'needs-action');
    this.enqueue(async () => {
      // A just-spawned agent reports a status before the list read below has ever seen it.
      await this.reloadSessions();
      if (waitingChanged || event.status === 'needs-action') await this.readPending(event.sessionId);
      this.rebuild();
    });
  }

  observeStream(event: ChatStreamEvent): void {
    // A session that is already waiting reports no new status when a second call parks or one is
    // answered in the app, so its pending list is re-read from the tool events instead.
    if (
      (event.type === 'tool-start' || event.type === 'tool-end') &&
      this.statuses.get(event.sessionId) === 'needs-action'
    ) {
      this.enqueue(async () => {
        await this.readPending(event.sessionId);
        this.rebuild();
      });
    }
    const next = foldActivity(this.activity, event);
    if (next === this.activity) return;
    this.activity = next;
    if (this.streamTimer !== undefined) return;
    this.streamTimer = setTimeout(() => {
      this.streamTimer = undefined;
      this.enqueue(async () => this.rebuild());
    }, STREAM_THROTTLE_MS);
  }

  /** Signed in, out or into another account: everything is re-read from the new scope. */
  scopeChanged(): void {
    this.pending.clear();
    this.unacknowledgedDone.clear();
    this.busyRoots.clear();
    this.busySinceRebuild.clear();
    this.enqueue(async () => {
      await this.reloadSessions();
      await Promise.all(
        [...this.statuses].filter(([, status]) => status === 'needs-action').map(([id]) => this.readPending(id))
      );
      this.rebuild();
    });
  }

  /** The user looked (main window focused, tray menu opened): finished work stops calling for them. */
  acknowledge(): void {
    if (this.unacknowledgedDone.size === 0) return;
    this.unacknowledgedDone.clear();
    this.enqueue(async () => this.rebuild());
  }

  /**
   * Answers a parked call from outside the app. Only a quick call in the current snapshot is
   * answered; anything else (already answered in the app, or one that needs the full card) is a
   * no-op that returns false.
   */
  async respond(approvalId: string, decision: WatchDecision): Promise<boolean> {
    const item = this.current.pending.find(candidate => candidate.approvalId === approvalId);
    if (!item?.quick) return false;
    await this.sources.resolveApproval(approvalId, { decision });
    this.enqueue(async () => {
      await this.readPending(item.sessionId);
      this.rebuild();
    });
    return true;
  }

  snapshot(): WatchSnapshot {
    return this.current;
  }

  onChange(listener: (snapshot: WatchSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once every queued rebuild has run; for tests. */
  settled(): Promise<void> {
    return this.queue;
  }

  dispose(): void {
    if (this.streamTimer !== undefined) clearTimeout(this.streamTimer);
    this.streamTimer = undefined;
    this.listeners.clear();
  }

  private now(): number {
    return this.sources.now?.() ?? Date.now();
  }

  private applyStatus(event: ChatSessionStatusEvent): void {
    const previous = this.statuses.get(event.sessionId);
    this.statuses.set(event.sessionId, event.status);
    if (event.status === 'processing' || event.status === 'needs-action') this.busySinceRebuild.add(event.sessionId);
    if (event.status === 'needs-action' && previous !== 'needs-action')
      this.needsYouSince.set(event.sessionId, this.now());
    if (event.status !== 'needs-action') {
      this.needsYouSince.delete(event.sessionId);
      this.pending.delete(event.sessionId);
    }
  }

  private enqueue(work: () => Promise<void>): void {
    this.queue = this.queue.then(work).catch((error: unknown) => {
      this.sources.warn(`WATCH: update failed: ${String(error)}`);
    });
  }

  private async reloadSessions(): Promise<void> {
    this.sessions = await this.sources.listSessions();
  }

  private async readPending(sessionId: string): Promise<void> {
    if (this.statuses.get(sessionId) !== 'needs-action') {
      this.pending.delete(sessionId);
      return;
    }
    // An unreadable session still counts as waiting; it just offers nothing to answer from here.
    const messages = await this.sources.sessionMessages(sessionId).catch(() => []);
    this.pending.set(sessionId, pendingCallsIn(messages));
  }

  private rebuild(): void {
    const input = {
      sessions: this.sessions,
      statuses: this.statuses,
      activity: this.activity,
      pending: this.pending,
      needsYouSince: this.needsYouSince,
      now: this.now(),
    };
    // Done is a transition: a root that was busy and now is not finished since the user last looked.
    const probe = buildWatchSnapshot({ ...input, unacknowledgedDone: new Set() });
    for (const orchestration of probe.orchestrations) {
      const busyNow = orchestration.sessions.some(session => {
        const status = this.statuses.get(session.id);
        return status === 'processing' || status === 'needs-action';
      });
      const workedSinceLast = orchestration.sessions.some(session => this.busySinceRebuild.has(session.id));
      if (busyNow) {
        this.busyRoots.add(orchestration.rootId);
        this.unacknowledgedDone.delete(orchestration.rootId);
      } else if (this.busyRoots.delete(orchestration.rootId) || workedSinceLast) {
        this.unacknowledgedDone.add(orchestration.rootId);
      }
    }
    this.busySinceRebuild.clear();
    const next = buildWatchSnapshot({ ...input, unacknowledgedDone: this.unacknowledgedDone });
    const key = JSON.stringify(next);
    if (key === this.currentKey) return;
    this.current = next;
    this.currentKey = key;
    for (const listener of this.listeners) listener(next);
  }
}
