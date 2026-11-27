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
    for (const sessionId of sessionIds) {
      const known = this.hosts.get(sessionId);
      if (known === undefined) this.hosts.set(sessionId, hostId);
      else if (known !== hostId) {
        refused.add(sessionId);
        this.reportClash(sessionId, known, hostId);
      }
    }
    return refused;
  }

  hostOf(sessionId: string): string | undefined {
    return this.hosts.get(sessionId);
  }

  forget(sessionIds: Iterable<string>): void {
    for (const sessionId of sessionIds) this.hosts.delete(sessionId);
  }

  /** Drops every session of a host that was removed. */
  forgetHost(hostId: string): void {
    for (const [sessionId, owner] of this.hosts) if (owner === hostId) this.hosts.delete(sessionId);
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
