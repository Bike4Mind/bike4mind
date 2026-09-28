import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatApprovalDecision, ChatMessage, ChatModelOption, ChatSession, ChatSessionSummary } from '@shared/chat';

export interface SessionsController {
  sessions: ChatSessionSummary[];
  loading: boolean;
  reload: () => Promise<void>;
  create: () => Promise<string>;
  remove: (sessionId: string) => Promise<void>;
  /** Apply a summary main just returned, so the sidebar reorders without a full reload. */
  apply: (summary: ChatSessionSummary) => void;
}

export function useSessions(): SessionsController {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);

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

  const remove = useCallback(async (sessionId: string) => {
    await window.b4m.chat.deleteSession(sessionId);
    setSessions(current => current.filter(session => session.id !== sessionId));
  }, []);

  const apply = useCallback((summary: ChatSessionSummary) => {
    setSessions(current => [summary, ...current.filter(session => session.id !== summary.id)]);
  }, []);

  return { sessions, loading, reload, create, remove, apply };
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
  send: (text: string) => Promise<void>;
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
    async (text: string) => {
      if (!sessionId) return;
      const prompt = text.trim();
      if (!prompt) return;

      setSendError(null);
      setNotice(null);
      const optimistic: ChatMessage = {
        // Temporary: main assigns the persisted id. They meet again on the next load, which is
        // the only place the difference could show, and by then this one is gone.
        id: `pending-${Date.now()}`,
        role: 'user',
        content: prompt,
        createdAt: new Date().toISOString(),
      };
      setMessages(current => [...current, optimistic]);

      const result = await window.b4m.chat.sendMessage({ sessionId, text: prompt });
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
