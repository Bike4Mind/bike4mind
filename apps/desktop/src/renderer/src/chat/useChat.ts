import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ChatApprovalDecision,
  ChatAttachment,
  ChatMessage,
  ChatModelOption,
  ChatSession,
  ChatSessionSummary,
  CreateCodeSessionRequest,
} from '@shared/chat';

export interface SessionsController {
  sessions: ChatSessionSummary[];
  loading: boolean;
  reload: () => Promise<void>;
  create: () => Promise<string>;
  /** Start a Code session. Resolves null when main refused; `codeError` then says why. */
  createCode: (request: CreateCodeSessionRequest) => Promise<string | null>;
  /** Set while a Code session is being created - resolving a worktree can take a moment. */
  creatingCode: boolean;
  codeError: string | null;
  clearCodeError: () => void;
  remove: (sessionId: string) => Promise<void>;
  togglePin: (session: ChatSessionSummary) => Promise<void>;
  /** Apply a summary main just returned, so the sidebar reorders without a full reload. */
  apply: (summary: ChatSessionSummary) => void;
}

export function useSessions(): SessionsController {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const next = await window.b4m.chat.listSessions();
    setSessions(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = useCallback(async () => {
    const created = await window.b4m.chat.createSession();
    setSessions(current => [created, ...current]);
    return created.id;
  }, []);

  const createCode = useCallback(async (request: CreateCodeSessionRequest) => {
    setCreatingCode(true);
    setCodeError(null);
    try {
      const result = await window.b4m.chat.createCodeSession(request);
      if (!result.ok) {
        setCodeError(result.error);
        return null;
      }
      setSessions(current => [result.session, ...current]);
      return result.session.id;
    } finally {
      setCreatingCode(false);
    }
  }, []);

  const remove = useCallback(async (sessionId: string) => {
    await window.b4m.chat.deleteSession(sessionId);
    setSessions(current => current.filter(session => session.id !== sessionId));
  }, []);

  const apply = useCallback((summary: ChatSessionSummary) => {
    setSessions(current => [summary, ...current.filter(session => session.id !== summary.id)]);
  }, []);

  // Patched in place rather than moved to the front: pinning does not touch `updatedAt`, so
  // reordering the row here would disagree with what the next reload shows.
  const togglePin = useCallback(async (session: ChatSessionSummary) => {
    const updated = await window.b4m.chat.setSessionPinned(session.id, !session.pinned);
    if (!updated) return;
    setSessions(current => current.map(entry => (entry.id === updated.id ? updated : entry)));
  }, []);

  const clearCodeError = useCallback(() => setCodeError(null), []);

  return {
    sessions,
    loading,
    reload,
    create,
    createCode,
    creatingCode,
    codeError,
    clearCodeError,
    remove,
    togglePin,
    apply,
  };
}

/**
 * Which sessions have a reply in flight, for the sidebar's status dots.
 *
 * Subscribed globally rather than derived from the open conversation: main streams replies for
 * every session at once, so a dot driven by the active conversation alone would show every
 * background session as idle - which is the one thing the dot exists to contradict.
 */
export function useRunningSessions(): ReadonlySet<string> {
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      // The background-* events outlive the turn that started one, so they say nothing about
      // whether a REPLY is streaming and must not clear the dot.
      if (event.type === 'background-output' || event.type === 'background-status') return;
      setRunning(current => {
        const isStart = event.type === 'start';
        if (isStart === current.has(event.sessionId)) return current;
        const next = new Set(current);
        if (isStart) next.add(event.sessionId);
        else if (event.type === 'done' || event.type === 'error') next.delete(event.sessionId);
        else return current;
        return next;
      });
    });
  }, []);

  return running;
}

export interface ModelCatalogController {
  models: ChatModelOption[];
  loading: boolean;
  /** Set when the list could not be READ. An empty list with no error means the server has none. */
  error: string | null;
  /** Refetch, bypassing main's cache. */
  reload: () => Promise<void>;
}

/**
 * The models this server offers, refetched when the environment changes.
 *
 * Auth state is the trigger rather than a timer: switching hosted -> self-host changes which
 * providers have keys, so the previous server's list is not just stale but wrong, and leaving
 * it on screen would offer models this deployment will reject.
 */
export function useModelCatalog(): ModelCatalogController {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    const catalog = await window.b4m.chat.listModels(force);
    setModels(catalog.models);
    setError(catalog.error ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    let lastKey: string | null = null;
    return window.b4m.auth.onStateChanged(state => {
      const key = `${state.status}:${state.environment.url}`;
      if (key === lastKey) return;
      lastKey = key;
      void load(true);
    });
  }, [load]);

  const reload = useCallback(() => load(true), [load]);

  return { models, loading, error, reload };
}

export interface ConversationController {
  session: ChatSession | null;
  messages: ChatMessage[];
  /** Set while a reply for THIS session is streaming. */
  streaming: boolean;
  sendError: string | null;
  /** One-shot message about something main changed while accepting a turn. Not a failure. */
  notice: string | null;
  dismissNotice: () => void;
  send: (text: string, attachments?: readonly ChatAttachment[]) => Promise<void>;
  stop: () => void;
  rename: (title: string) => Promise<void>;
  /** Pin this conversation to a model; it is used from the next turn on. */
  setModel: (model: string) => Promise<void>;
  /** Answer a tool call waiting at the approval gate. Nothing has run until this is called. */
  respondToApproval: (approvalId: string, decision: ChatApprovalDecision) => void;
}

/**
 * One conversation, kept in step with main's reply stream.
 *
 * Main streams the reply whether or not this hook is mounted, and persists the finished turn,
 * so switching sessions mid-reply loses only the live view of it - reopening shows the
 * complete message once it lands.
 */
export function useConversation(
  sessionId: string | null,
  onSummaryChanged: (summary: ChatSessionSummary) => void
): ConversationController {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Read inside the IPC subscription, which must not be torn down and rebuilt per session
  // change: a rebuild between 'start' and the first 'delta' would drop tokens.
  const activeSessionId = useRef<string | null>(sessionId);
  activeSessionId.current = sessionId;

  useEffect(() => {
    setSendError(null);
    setNotice(null);
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      setStreaming(false);
      return;
    }

    let current = true;
    void window.b4m.chat.getSession(sessionId).then(loaded => {
      if (!current) return;
      setSession(loaded);
      setMessages(loaded?.messages ?? []);
      // A reply already running for this session keeps streaming into main; this view just
      // rejoins at whatever is persisted until the next event arrives.
      setStreaming(false);
    });
    return () => {
      current = false;
    };
  }, [sessionId]);

  useEffect(() => {
    return window.b4m.chat.onStreamEvent(event => {
      if (event.sessionId !== activeSessionId.current) return;

      if (event.type === 'start') {
        setStreaming(true);
        setMessages(current => [
          ...current,
          { id: event.messageId, role: 'assistant', content: '', createdAt: new Date().toISOString() },
        ]);
        return;
      }

      if (event.type === 'delta') {
        setMessages(current =>
          current.map(message =>
            message.id === event.messageId ? { ...message, content: message.content + event.text } : message
          )
        );
        return;
      }

      if (event.type === 'tool-start' || event.type === 'tool-end') {
        setMessages(current =>
          current.map(message => {
            if (message.id !== event.messageId) return message;
            const existing = message.toolCalls ?? [];
            const known = existing.some(call => call.id === event.call.id);
            return {
              ...message,
              toolCalls: known
                ? existing.map(call => (call.id === event.call.id ? event.call : call))
                : [...existing, event.call],
            };
          })
        );
        return;
      }

      // Only 'done' and 'error' end a reply. Stated rather than left to the fall-through,
      // because the background-process events arrive with no reply in flight at all, and
      // treating an unrecognised event as terminal would blank the streaming indicator.
      if (event.type !== 'done' && event.type !== 'error') return;

      setStreaming(false);
      setMessages(current =>
        current.map(message => {
          if (message.id !== event.messageId) return message;
          return event.type === 'done'
            ? {
                ...message,
                content: event.content,
                stopReason: event.stopReason,
                toolCalls: event.toolCalls ?? message.toolCalls,
              }
            : { ...message, error: event.message };
        })
      );
    });
  }, []);

  const send = useCallback(
    async (text: string, attachments: readonly ChatAttachment[] = []) => {
      if (!sessionId) return;
      const prompt = text.trim();
      // An attachment on its own is a turn; only a turn with neither is not.
      if (!prompt && attachments.length === 0) return;

      setSendError(null);
      setNotice(null);
      const optimistic: ChatMessage = {
        // Temporary: main assigns the persisted id. They meet again on the next load, which is
        // the only place the difference could show, and by then this one is gone.
        id: `pending-${Date.now()}`,
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      };
      setMessages(current => [...current, optimistic]);

      const result = await window.b4m.chat.sendMessage({
        sessionId,
        text: prompt,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      });
      if (!result.ok) {
        setMessages(current => current.filter(message => message.id !== optimistic.id));
        setSendError(result.error);
        return;
      }
      if (result.notice) setNotice(result.notice);

      const summary = await window.b4m.chat.getSession(sessionId);
      if (summary) {
        setSession(summary);
        const { messages: _messages, ...rest } = summary;
        onSummaryChanged({ ...rest, messageCount: summary.messages.length });
      }
    },
    [sessionId, onSummaryChanged]
  );

  const stop = useCallback(() => {
    if (sessionId) void window.b4m.chat.stopReply(sessionId);
  }, [sessionId]);

  const rename = useCallback(
    async (title: string) => {
      if (!sessionId) return;
      const updated = await window.b4m.chat.renameSession(sessionId, title);
      if (!updated) return;
      setSession(current => (current ? { ...current, title: updated.title } : current));
      onSummaryChanged(updated);
    },
    [sessionId, onSummaryChanged]
  );

  const setModel = useCallback(
    async (model: string) => {
      if (!sessionId) return;
      const updated = await window.b4m.chat.setSessionModel(sessionId, model);
      if (!updated) return;
      setNotice(null);
      setSession(current => (current ? { ...current, model: updated.model } : current));
      onSummaryChanged(updated);
    },
    [sessionId, onSummaryChanged]
  );

  const respondToApproval = useCallback((approvalId: string, decision: ChatApprovalDecision) => {
    void window.b4m.chat.respondToApproval(approvalId, decision);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return {
    session,
    messages,
    streaming,
    sendError,
    notice,
    dismissNotice,
    send,
    stop,
    rename,
    setModel,
    respondToApproval,
  };
}
