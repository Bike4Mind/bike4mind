import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatApprovalAnswer,
  ChatApprovalMode,
  ChatAttachment,
  ChatMessage,
  ChatModelOption,
  ChatQueuedMessage,
  ChatSession,
  ChatSessionStatus,
  ChatSessionSummary,
  CreateCodeSessionRequest,
  UpdateProjectRequest,
} from '@shared/chat';
import { describeReturn } from './queuedMessages';
import { applyLiveEvent, coalesceLiveEvents, startReply, type LiveReplyEvent } from '@shared/liveReply';
import { applyReplyDone } from './replyDone';
import { applyStatusEvents } from './sessionStatus';
import { totalTokens, type TurnProgress } from './statusLine';

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
  toggleArchived: (session: ChatSessionSummary) => Promise<void>;
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

  // Patched in place rather than moved to the front, the way pinning is: a generated title does
  // not touch `updatedAt`, so reordering here would disagree with the next reload. An id this
  // window does not hold is ignored - the push reaches every window, including ones that have
  // not listed that session yet.
  useEffect(() => {
    return window.b4m.chat.onSessionSummary(summary => {
      setSessions(current => current.map(entry => (entry.id === summary.id ? summary : entry)));
    });
  }, []);

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

  // Patched in place rather than moved, for the same reason pinning is: archiving does not
  // touch `updatedAt`, and the row is about to change section anyway.
  const toggleArchived = useCallback(async (session: ChatSessionSummary) => {
    const updated = await window.b4m.chat.setSessionArchived(session.id, !session.archived);
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
    toggleArchived,
    apply,
  };
}

/**
 * What every session is doing, for the sidebar's status badges.
 *
 * The renderer does not work this out. Main owns it (see main/chat/SessionActivity) and pushes
 * it, and this hook only folds those pushes into a map. That division is the whole point: the
 * state that matters most - a background session parked at the approval gate - produces no
 * stream events a newly opened window would see, so anything derived here from what this
 * window happened to witness would draw it as idle.
 */
export function useSessionStatuses(): ReadonlyMap<string, ChatSessionStatus> {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, ChatSessionStatus>>(() => new Map());

  useEffect(() => {
    let live = true;
    // Sessions a push has already spoken for. Subscribing BEFORE reading the snapshot is what
    // stops a change landing in the gap being lost, but it also means the snapshot can resolve
    // already stale for a session - so it is applied only to sessions no push has covered.
    const pushed = new Set<string>();

    const unsubscribe = window.b4m.chat.onSessionStatus(event => {
      pushed.add(event.sessionId);
      setStatuses(current => applyStatusEvents(current, [event]));
    });

    void window.b4m.chat.getSessionStatuses().then(snapshot => {
      if (!live) return;
      setStatuses(current =>
        applyStatusEvents(
          current,
          snapshot.filter(entry => !pushed.has(entry.sessionId))
        )
      );
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return statuses;
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

export interface ProjectBindingError {
  message: string;
  /** Refused on timing rather than validity: the same change works once the session is idle. */
  busy: boolean;
  /**
   * Set when nothing went wrong and nothing happened - a dismissed folder picker, above all.
   * It still has to be said, because a click that produces no visible change is the failure
   * this row exists to stop being silent; it just is not drawn in red.
   */
  info?: boolean;
}

/** Everything the chip row above the composer can change about a Code session's grounding. */
export interface ProjectBindingController {
  /** Set while a change is in flight - resolving a worktree can take a moment. */
  busy: boolean;
  error: ProjectBindingError | null;
  dismissError: () => void;
  /** Open the folder picker, then re-root the session on whatever is chosen. */
  pickDirectory: () => Promise<void>;
  setBranch: (branch: string) => Promise<void>;
  setWorkspace: (workspace: boolean) => Promise<void>;
  addContextDirectory: () => Promise<void>;
  removeContextDirectory: (directory: string) => Promise<void>;
}

export interface ConversationController {
  session: ChatSession | null;
  messages: ChatMessage[];
  /** Set while a reply for THIS session is streaming. */
  streaming: boolean;
  /** Elapsed clock and server-reported cost of the turn in flight; null when none is. */
  turn: TurnProgress | null;
  sendError: string | null;
  /** One-shot message about something main changed while accepting a turn. Not a failure. */
  notice: string | null;
  dismissNotice: () => void;
  send: (text: string, attachments?: readonly ChatAttachment[]) => Promise<void>;
  stop: () => void;
  /** Resume the last reply if the agent loop's budget cut it short. */
  continueReply: () => Promise<void>;
  /** Messages typed ahead of the live turn, oldest first. Empty unless one is streaming. */
  queued: ChatQueuedMessage[];
  /** Take one back. Its text returns through `returned`, which is also how it is edited. */
  cancelQueued: (queuedId: string) => void;
  /**
   * Text the queue handed back, for the composer to take in. A new object each time, so a
   * consumer can key an effect on its identity; `clearReturned` acknowledges it.
   */
  returned: { id: number; messages: ChatQueuedMessage[] } | null;
  clearReturned: () => void;
  /**
   * Replies this window has watched end, in ANY conversation. Monotonic, and a trigger rather
   * than a statistic: it is what tells the credit balance it is worth re-reading.
   */
  settledTurns: number;
  rename: (title: string) => Promise<void>;
  /** Pin this conversation to a model; it is used from the next turn on. */
  setModel: (model: string) => Promise<void>;
  /**
   * Set how much this conversation may do without asking. Driven by the composer pill, from a
   * click, and from nothing else: this is the only path to the mode in the renderer.
   */
  setApprovalMode: (mode: ChatApprovalMode) => Promise<void>;
  /** Where this Code session is grounded, for the chip row. Inert on a Chat session. */
  project: ProjectBindingController;
  /** Answer a tool call waiting at the approval gate. Nothing has run until this is called. */
  respondToApproval: (approvalId: string, answer: ChatApprovalAnswer) => void;
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
  const [turn, setTurn] = useState<TurnProgress | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<ProjectBindingError | null>(null);
  const [queued, setQueued] = useState<ChatQueuedMessage[]>([]);
  const [returned, setReturned] = useState<{ id: number; messages: ChatQueuedMessage[] } | null>(null);
  const [settledTurns, setSettledTurns] = useState(0);
  /**
   * Batch counter for returned text, monotonic for the life of this hook.
   *
   * NOT derived from `returned` itself: that is cleared on every session change, so the count
   * would restart at 1 and the composer - which remembers the last batch it took in - would
   * silently skip the next one as already consumed. The user then got the notice saying their
   * text was back, with an empty composer.
   */
  const returnBatch = useRef(0);

  // Read inside the IPC subscription, which must not be torn down and rebuilt per session
  // change: a rebuild between 'start' and the first 'delta' would drop tokens.
  const activeSessionId = useRef<string | null>(sessionId);
  activeSessionId.current = sessionId;

  /** Replies this window has seen end; see the session load, which must not reopen one. */
  const settledReplies = useRef(new Set<string>());

  useEffect(() => {
    setSendError(null);
    setNotice(null);
    setProjectError(null);
    setReturned(null);
    setQueued([]);
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      setStreaming(false);
      setTurn(null);
      return;
    }

    let current = true;
    const load = (): void => {
      void window.b4m.chat.getSession(sessionId).then(loaded => {
        if (!current) return;
        // A reply already running arrives as main's live copy, and the events from now on
        // extend it. One that settled while this read was in flight is stale: read again
        // rather than put back a turn the 'done' already closed.
        const live = loaded?.replyInFlight;
        if (live && settledReplies.current.has(live.messageId)) return load();
        setSession(loaded);
        setMessages(loaded?.messages ?? []);
        setStreaming(!!live);
        setTurn(live ? { startedAt: live.startedAt, tokens: null } : null);
      });
    };
    load();
    // Read rather than derived: main owns the queue, and a window opening onto a session that
    // was queued into from another one has witnessed no push for it.
    void window.b4m.chat.getQueuedMessages(sessionId).then(pending => {
      if (current) setQueued(pending);
    });
    return () => {
      current = false;
    };
  }, [sessionId]);

  // The header reads the open conversation's own copy of the title, so the sidebar's patch is
  // not enough: without this, the row renames itself and the heading above the thread does not.
  useEffect(() => {
    return window.b4m.chat.onSessionSummary(summary => {
      if (summary.id !== activeSessionId.current) return;
      setSession(current => (current ? { ...current, title: summary.title } : current));
    });
  }, []);

  useEffect(() => {
    return window.b4m.chat.onQueueChanged(event => {
      if (event.sessionId !== activeSessionId.current) return;
      setQueued(event.queued);
      // Main appended this one to the thread itself, so this window has no copy of it. Guarded
      // against a duplicate because the same push reaches every open window.
      const appended = event.sent?.message;
      if (appended) {
        setMessages(current =>
          current.some(message => message.id === appended.id) ? current : [...current, appended]
        );
      }
      const explanation = describeReturn(event.returned);
      if (explanation) setNotice(explanation);
      // Counted, not content-keyed: two cancels of the same text must both reach the composer.
      const back = event.returned;
      if (back) setReturned({ id: ++returnBatch.current, messages: back.messages });
    });
  }, []);

  useEffect(() => {
    // Live events are folded once per frame: main sends one per token, and a state update each
    // would rebuild the whole thread far faster than it can paint.
    let queued: LiveReplyEvent[] = [];
    let frame: number | undefined;
    const flushLive = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      if (queued.length === 0) return;
      const events = coalesceLiveEvents(queued);
      queued = [];
      setMessages(current =>
        current.map(message => events.reduce((folded, event) => applyLiveEvent(folded, event), message))
      );
    };

    const unsubscribe = window.b4m.chat.onStreamEvent(event => {
      const live =
        event.type === 'delta' ||
        event.type === 'tool-start' ||
        event.type === 'tool-end' ||
        event.type === 'tool-progress';
      if (live) {
        if (event.sessionId !== activeSessionId.current) return;
        queued.push(event);
        frame ??= requestAnimationFrame(flushLive);
        return;
      }
      // Anything that is not a live event may depend on, or replace, what is still queued.
      flushLive();

      if (event.type === 'done' || event.type === 'error') {
        settledReplies.current.add(event.messageId);
        // Counted before the session filter below, and deliberately: a reply running in a
        // background conversation spends from the same balance as this one.
        setSettledTurns(count => count + 1);
      }
      if (event.sessionId !== activeSessionId.current) return;

      if (event.type === 'start') {
        setStreaming(true);
        setTurn({ startedAt: Date.now(), tokens: null });
        setMessages(current => startReply(current, event.messageId));
        return;
      }

      // The running total the server has reported so far. Kept only while a turn is open, so
      // nothing survives to be shown against the next one.
      if (event.type === 'usage') {
        const counted = totalTokens(event.usage);
        if (counted !== null)
          setTurn(current => (current ? { ...current, tokens: counted, usage: event.usage } : current));
        return;
      }

      // A message that arrived without anyone typing it - a spawned session reporting back.
      // Appended rather than folded into a streaming reply: it belongs to no turn in flight.
      if (event.type === 'message') {
        setMessages(current =>
          current.some(message => message.id === event.message.id) ? current : [...current, event.message]
        );
        return;
      }

      // Only 'done' and 'error' end a reply. Stated rather than left to the fall-through,
      // because the background-process events arrive with no reply in flight at all, and
      // treating an unrecognised event as terminal would blank the streaming indicator.
      if (event.type !== 'done' && event.type !== 'error') return;

      setStreaming(false);
      setTurn(null);
      setMessages(current => {
        // Absent when this window opened in the gap between main dropping its live copy and
        // storing the reply; the terminal event is then the only copy it will get.
        const base = current.some(message => message.id === event.messageId)
          ? current
          : startReply(current, event.messageId);
        return base.map(message => {
          if (message.id !== event.messageId) return message;
          return event.type === 'done' ? applyReplyDone(message, event) : { ...message, error: event.message };
        });
      });
    });

    return () => {
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, []);

  const send = useCallback(
    async (text: string, attachments: readonly ChatAttachment[] = []) => {
      if (!sessionId) return;
      const prompt = text.trim();
      // An attachment on its own is a turn; only a turn with neither is not.
      if (!prompt && attachments.length === 0) return;

      setSendError(null);
      setNotice(null);

      // Drawn before the round trip so the thread answers the keystroke immediately - but only
      // when this turn is going out now. Main decides queueing, so `streaming` is a guess here;
      // it is only ever wrong in the gap where a reply has just ended, and the result below
      // corrects it either way. A queued message must NOT appear in the transcript: that would
      // claim it had been sent, which is the one thing it has not been.
      const optimistic: ChatMessage | null = streaming
        ? null
        : {
            // Temporary: main assigns the persisted id. They meet again on the next load, which
            // is the only place the difference could show, and by then this one is gone.
            id: `pending-${Date.now()}`,
            role: 'user',
            content: prompt,
            createdAt: new Date().toISOString(),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          };
      if (optimistic) setMessages(current => [...current, optimistic]);

      const discardOptimistic = () => {
        if (optimistic) setMessages(current => current.filter(message => message.id !== optimistic.id));
      };

      const result = await window.b4m.chat.sendMessage({
        sessionId,
        text: prompt,
        ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      });
      if (!result.ok) {
        discardOptimistic();
        setSendError(result.error);
        return;
      }
      // It queued after all: the pending row above the composer is where it lives now.
      if (result.queued) {
        discardOptimistic();
        return;
      }
      if (result.notice) setNotice(result.notice);
      // It went out although this window thought a reply was running - the turn that was
      // streaming had already ended. The thread has to show the prompt that is now in it.
      if (!optimistic) {
        setMessages(current => [
          ...current,
          {
            id: `pending-${Date.now()}`,
            role: 'user',
            content: prompt,
            createdAt: new Date().toISOString(),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          },
        ]);
      }

      const summary = await window.b4m.chat.getSession(sessionId);
      if (summary) {
        setSession(summary);
        const { messages: _messages, ...rest } = summary;
        onSummaryChanged({ ...rest, messageCount: summary.messages.length });
      }
    },
    [sessionId, streaming, onSummaryChanged]
  );

  const stop = useCallback(() => {
    if (sessionId) void window.b4m.chat.stopReply(sessionId);
  }, [sessionId]);

  // No optimistic update: the reply's own 'start' event clears the stop-reason chip, and doing
  // it here as well would hide the button on a continue main went on to refuse.
  const continueReply = useCallback(async () => {
    if (!sessionId) return;
    setSendError(null);
    const result = await window.b4m.chat.continueReply(sessionId);
    if (!result.ok) setSendError(result.error);
  }, [sessionId]);
  const cancelQueued = useCallback(
    (queuedId: string) => {
      if (sessionId) void window.b4m.chat.cancelQueuedMessage(sessionId, queuedId);
    },
    [sessionId]
  );

  const clearReturned = useCallback(() => setReturned(null), []);

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

  const setApprovalMode = useCallback(
    async (mode: ChatApprovalMode) => {
      if (!sessionId) return;
      const updated = await window.b4m.chat.setApprovalMode(sessionId, mode);
      if (!updated) return;
      setSession(current => (current ? { ...current, approvalMode: updated.approvalMode } : current));
      onSummaryChanged(updated);
    },
    [sessionId, onSummaryChanged]
  );

  const respondToApproval = useCallback((approvalId: string, answer: ChatApprovalAnswer) => {
    void window.b4m.chat.respondToApproval(approvalId, answer);
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  // A summary main just wrote, folded into both the open conversation and the sidebar row.
  const applySummary = useCallback(
    (updated: ChatSessionSummary) => {
      setSession(current => (current ? { ...current, project: updated.project } : current));
      onSummaryChanged(updated);
    },
    [onSummaryChanged]
  );

  /** Resolves true when the session really moved, so a caller can report what happened after. */
  const changeProject = useCallback(
    async (change: Omit<UpdateProjectRequest, 'sessionId'>) => {
      if (!sessionId) return false;
      setProjectBusy(true);
      setProjectError(null);
      try {
        const result = await window.b4m.chat.updateProject({ sessionId, ...change });
        if (!result.ok) {
          setProjectError({ message: result.error, busy: !!result.busy });
          return false;
        }
        applySummary(result.session);
        return true;
      } finally {
        setProjectBusy(false);
      }
    },
    [sessionId, applySummary]
  );

  const pickDirectory = useCallback(async () => {
    setProjectError(null);
    const directory = await window.b4m.chat.pickProjectDirectory();
    if (!directory) {
      setProjectError({ message: 'No folder chosen, so nothing changed.', busy: false, info: true });
      return;
    }
    const inspected = await window.b4m.chat.inspectProject(directory);
    // The workspace choice does not travel: it named a worktree of the repository being left,
    // and carrying it across would create one in a repository the user has only just pointed at.
    const moved = await changeProject({ directory, branch: inspected.currentBranch ?? '', workspace: false });
    // The folder is still usable when git could not be read - it just has no branches to offer -
    // so this is reported after the move rather than instead of it.
    if (moved && inspected.error) setProjectError({ message: inspected.error, busy: false });
  }, [changeProject]);

  const setBranch = useCallback(
    async (branch: string) => {
      await changeProject({ branch });
    },
    [changeProject]
  );
  const setWorkspace = useCallback(
    async (workspace: boolean) => {
      await changeProject({ workspace });
    },
    [changeProject]
  );

  const addContextDirectory = useCallback(async () => {
    if (!sessionId) return;
    setProjectError(null);
    const updated = await window.b4m.chat.addContextDirectory(sessionId);
    // Null is a dismissed picker: the button is disabled until the session has a project, so
    // the other way main returns null is not reachable from here.
    if (!updated) {
      setProjectError({ message: 'No folder chosen, so nothing was added.', busy: false, info: true });
      return;
    }
    applySummary(updated);
  }, [sessionId, applySummary]);

  const removeContextDirectory = useCallback(
    async (directory: string) => {
      if (!sessionId) return;
      const updated = await window.b4m.chat.removeContextDirectory(sessionId, directory);
      if (updated) applySummary(updated);
    },
    [sessionId, applySummary]
  );

  const dismissProjectError = useCallback(() => setProjectError(null), []);

  const project = useMemo<ProjectBindingController>(
    () => ({
      busy: projectBusy,
      error: projectError,
      dismissError: dismissProjectError,
      pickDirectory,
      setBranch,
      setWorkspace,
      addContextDirectory,
      removeContextDirectory,
    }),
    [
      projectBusy,
      projectError,
      dismissProjectError,
      pickDirectory,
      setBranch,
      setWorkspace,
      addContextDirectory,
      removeContextDirectory,
    ]
  );

  return {
    session,
    messages,
    streaming,
    turn,
    sendError,
    notice,
    dismissNotice,
    send,
    stop,
    continueReply,
    queued,
    cancelQueued,
    returned,
    clearReturned,
    settledTurns,
    rename,
    setModel,
    setApprovalMode,
    project,
    respondToApproval,
  };
}
