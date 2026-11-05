import type { AttentionNotice } from '@shared/attention';
import type { ChatMessage, ChatSessionStatus, ChatSessionStatusEvent, ChatSessionSummary } from '@shared/chat';
import { alertableSessions, needsYouBody, needsYouCount, needsYouTitle, rootSessionOf } from '@shared/needsYou';

export type NeedsYouMonitorDeps = {
  /** The signed-in scope's sessions (device-local ones when signed out): only these alert or count. */
  listSessions(): Promise<ChatSessionSummary[]>;
  sessionMessages(sessionId: string): Promise<readonly ChatMessage[]>;
  /** An app window is open; its renderer then announces entries and owns the badge. */
  hasWindow(): boolean;
  /** The claim map the renderers use, so an entry a closing window already announced is not repeated. */
  claim(sessionIds: readonly string[]): string[];
  notify(notice: AttentionNotice): void;
  setBadge(count: number): void;
  warn(message: string): void;
};

/**
 * Needs-you notices and the dock badge while no app window is open (macOS keeps the app running
 * with every window closed). With a window open the renderer does this (useNeedsYouAlerts) and the
 * monitor only keeps its status map current, so it can take over the moment the last window closes.
 */
export class NeedsYouMonitor {
  private readonly statuses = new Map<string, ChatSessionStatus>();
  // Serialised so badge writes land in event order even though each one reads the session list.
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: NeedsYouMonitorDeps) {}

  observe(event: ChatSessionStatusEvent): void {
    const previous = this.statuses.get(event.sessionId);
    this.statuses.set(event.sessionId, event.status);
    if (this.deps.hasWindow()) return;
    const entered = event.status === 'needs-action' && previous !== 'needs-action' ? event.sessionId : null;
    this.enqueue(() => this.update(entered));
  }

  /** The last app window closed: the badge it kept is now main's to keep. */
  windowsClosed(): void {
    this.enqueue(() => this.update(null));
  }

  /**
   * Signed in, out or into another account: the waiting sessions were the old scope's, so the badge
   * is recounted from the new one's list. With a window open its renderer does that as the chat remounts.
   */
  scopeChanged(): void {
    if (this.deps.hasWindow()) return;
    this.enqueue(() => this.update(null));
  }

  /** Resolves once every queued update has run; for tests. */
  settled(): Promise<void> {
    return this.pending;
  }

  private enqueue(work: () => Promise<void>): void {
    this.pending = this.pending.then(work).catch((error: unknown) => {
      this.deps.warn(`ATTENTION: needs-you update failed: ${String(error)}`);
    });
  }

  private async update(entered: string | null): Promise<void> {
    const sessions = await this.deps.listSessions();
    // A window that opened while the list was read has a renderer that took over from here.
    if (this.deps.hasWindow()) return;
    this.deps.setBadge(needsYouCount(this.statuses, sessions));
    if (entered === null || this.statuses.get(entered) !== 'needs-action') return;
    if (!alertableSessions(sessions).has(entered)) return;
    if (this.deps.claim([entered]).length === 0) return;

    const rootId = rootSessionOf(sessions, entered);
    // A session that cannot be read still gets its notice, just without the request spelled out.
    const messages = await this.deps.sessionMessages(entered).catch(() => []);
    this.deps.notify({
      sessionId: entered,
      rootId,
      title: needsYouTitle(sessions, entered, rootId),
      body: needsYouBody(messages),
    });
  }
}
