import type { ChatSessionSummary } from '@shared/chat';
import { LOCAL_HOST_ID } from '@shared/hostBridge';

/**
 * Which host each session lives on. Session ids stay the renderer's key everywhere (last session,
 * sidebar sections, drafts, orchestrator prefs); this is the one place that maps an id to its host.
 * It relies on hosts minting ids as random UUIDs (main/chat/SessionStore), so two hosts never
 * list the same id; one that does anyway keeps its first host, and the clash is reported.
 */
export class SessionDirectory {
  private readonly hosts = new Map<string, string>();
  // Where a session was last seen, from before any host listed it this run (see expect).
  private readonly expected = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private notifyScheduled = false;

  constructor(
    private readonly reportClash: (sessionId: string, kept: string, refused: string) => void = (
      sessionId,
      kept,
      refused
    ) => console.warn(`Session ${sessionId} is listed by hosts ${kept} and ${refused}; keeping ${kept}`)
  ) {}

  /** Records that `hostId` lists these sessions; returns the ids it refused because another host holds them. */
  record(hostId: string, sessionIds: Iterable<string>): Set<string> {
    const refused = new Set<string>();
    let changed = false;
    for (const sessionId of sessionIds) {
      const known = this.hosts.get(sessionId);
      if (known === undefined) {
        changed ||= this.expected.get(sessionId) !== hostId;
        this.hosts.set(sessionId, hostId);
        this.expected.delete(sessionId);
      } else if (known !== hostId) {
        refused.add(sessionId);
        this.reportClash(sessionId, known, hostId);
      }
    }
    if (changed) this.notify();
    return refused;
  }

  /**
   * Notes where a session is expected to be before any host has listed it (a session remembered
   * from the last run), so its requests go there. A listing that finds it elsewhere overrides this
   * without a clash.
   */
  expect(hostId: string, sessionIds: Iterable<string>): void {
    let changed = false;
    for (const sessionId of sessionIds) {
      if (this.hosts.has(sessionId) || this.expected.get(sessionId) === hostId) continue;
      this.expected.set(sessionId, hostId);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The host a session is on, or expected on; undefined for one no host has listed or been expected to. */
  hostOf(sessionId: string): string | undefined {
    return this.hosts.get(sessionId) ?? this.expected.get(sessionId);
  }

  forget(sessionIds: Iterable<string>): void {
    let changed = false;
    for (const sessionId of sessionIds) {
      changed = this.hosts.delete(sessionId) || changed;
      changed = this.expected.delete(sessionId) || changed;
    }
    if (changed) this.notify();
  }

  /** Drops every session of a host that was removed. */
  forgetHost(hostId: string): void {
    const before = this.hosts.size + this.expected.size;
    for (const [sessionId, owner] of this.hosts) if (owner === hostId) this.hosts.delete(sessionId);
    for (const [sessionId, owner] of this.expected) if (owner === hostId) this.expected.delete(sessionId);
    if (this.hosts.size + this.expected.size !== before) this.notify();
  }

  /**
   * Called after the directory learns or loses a session's host. Batched to a microtask: rows are
   * recorded inside state updaters, where re-rendering a subscriber synchronously is not allowed.
   */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      for (const listener of this.listeners) listener();
    });
  }
}

export const sessionDirectory = new SessionDirectory();

/**
 * Rows from `hostId`, recorded in `directory` and, for a remote host, stamped with it; a local row
 * stays unstamped, exactly as main sent it. A row another host already holds is left out, so the
 * clash never reaches the sidebar as a duplicate.
 */
export function receiveRows(
  hostId: string,
  rows: readonly ChatSessionSummary[],
  directory: SessionDirectory = sessionDirectory
): ChatSessionSummary[] {
  const refused = directory.record(
    hostId,
    rows.map(row => row.id)
  );
  const kept = refused.size === 0 ? [...rows] : rows.filter(row => !refused.has(row.id));
  return hostId === LOCAL_HOST_ID ? kept : kept.map(row => withHostStamp(row, hostId));
}

/** `row` stamped with its remote host; a local row is returned as it is. */
export function withHostStamp(row: ChatSessionSummary, hostId: string): ChatSessionSummary {
  if (hostId === LOCAL_HOST_ID || row.hostId === hostId) return row;
  return { ...row, hostId };
}

/** The host a listed row belongs to; a row without a stamp came from Desktop's own IPC, so is local. */
export function summaryHostId(session: Pick<ChatSessionSummary, 'hostId'>): string {
  return session.hostId ?? LOCAL_HOST_ID;
}
