import type { ChatAttachment, ChatMessage, ChatSessionSummary } from '@shared/chat';

export type ContextSelection =
  | { readonly kind: 'current' }
  | { readonly kind: 'family' }
  | { readonly kind: 'explicit'; readonly sessionIds: readonly string[] };

export interface ContextRequest {
  readonly sessionId: string;
  readonly selection: ContextSelection;
  readonly files?: readonly string[];
}

export interface ContextLimits {
  readonly candidates: number;
  readonly sessions: number;
  readonly sources: number;
  readonly sourceBytes: number;
  readonly totalBytes: number;
}

export type SessionContext = {
  readonly id: string;
  readonly messages: readonly Pick<ChatMessage, 'id' | 'role' | 'content' | 'attachments'>[];
};

export type ReadResult<T> =
  { readonly status: 'ok'; readonly value: T } | { readonly status: 'denied' | 'missing' | 'unavailable' };

export interface ContextText {
  readonly text: string;
  readonly truncated?: boolean;
}

export interface ContextReaders {
  /** All readers stay in the requester's account scope; never borrow a source session's grants. */
  readonly scopeKey: () => string;
  readonly listSessions: (
    requester: string,
    limit: number,
    signal: AbortSignal
  ) => Promise<readonly Pick<ChatSessionSummary, 'id' | 'origin'>[]>;
  readonly readSession: (requester: string, id: string, signal: AbortSignal) => Promise<ReadResult<SessionContext>>;
  readonly readAttachment: (
    requester: string,
    ownerSessionId: string,
    attachment: Readonly<ChatAttachment>,
    maxBytes: number,
    signal: AbortSignal
  ) => Promise<ReadResult<ContextText>>;
  /** Must authorize and bound the read, returning a canonical identity for deduplication. */
  readonly readFile: (
    requester: string,
    path: string,
    maxBytes: number,
    signal: AbortSignal
  ) => Promise<ReadResult<ContextText & { readonly canonicalPath: string }>>;
}

export type ContextSource =
  | { readonly kind: 'message'; readonly sessionId: string; readonly messageId: string; readonly role: string }
  | { readonly kind: 'attachment'; readonly sessionId: string; readonly attachmentId: string }
  | { readonly kind: 'file'; readonly path: string };

export interface ContextEntry {
  readonly source: ContextSource;
  readonly text: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly truncated: boolean;
}

export interface ContextIssue {
  readonly source: string;
  readonly reason: 'denied' | 'missing' | 'unavailable' | 'limit' | 'truncated';
}

export interface ContextSnapshot {
  readonly sessionId: string;
  readonly selection: ContextSelection;
  readonly sessionIds: readonly string[];
  readonly entries: readonly ContextEntry[];
  readonly issues: readonly ContextIssue[];
  readonly totalBytes: number;
  readonly sha256: string;
}
