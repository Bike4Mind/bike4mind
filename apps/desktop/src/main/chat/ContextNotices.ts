import {
  HELD_CONTEXT_NOTICE_KINDS,
  type ActiveContextNotice,
  type ChatStreamEvent,
  type ContextNoticeKind,
} from '@shared/chat';

const isHeld = (kind: ContextNoticeKind | undefined): kind is ContextNoticeKind =>
  kind !== undefined && HELD_CONTEXT_NOTICE_KINDS.includes(kind);

/**
 * The one way a session's context notices go out: each call emits the stream event (which the
 * host also broadcasts as session/contextNotice) and updates the notices still in force, which
 * session/get returns so a window that reconnects shows the banner as it stands. Only the
 * HELD_CONTEXT_NOTICE_KINDS are kept; the rest are a turn's passing message.
 * In memory only: a host restart ends its runs, and with them the budget a warning was about.
 */
export class ContextNotices {
  private readonly held = new Map<string, Map<ContextNoticeKind, string>>();

  constructor(private readonly emit: (event: ChatStreamEvent) => void) {}

  show(sessionId: string, message: string, kind?: ContextNoticeKind): void {
    if (isHeld(kind)) {
      const notices = this.held.get(sessionId) ?? new Map<ContextNoticeKind, string>();
      notices.set(kind, message);
      this.held.set(sessionId, notices);
    }
    this.emit({ type: 'context-notice', sessionId, message, ...(kind ? { kind } : {}) });
  }

  clear(sessionId: string, kind: ContextNoticeKind): void {
    const notices = this.held.get(sessionId);
    notices?.delete(kind);
    if (notices?.size === 0) this.held.delete(sessionId);
    this.emit({ type: 'context-notice-cleared', sessionId, kind });
  }

  /** Drops a deleted session's notices without announcing anything. */
  forget(sessionId: string): void {
    this.held.delete(sessionId);
  }

  active(sessionId: string): ActiveContextNotice[] {
    return [...(this.held.get(sessionId) ?? [])].map(([kind, message]) => ({ kind, message }));
  }
}
