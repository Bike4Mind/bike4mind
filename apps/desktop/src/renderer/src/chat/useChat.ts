import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BranchElsewhere,
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
  ModelPhase,
  ReasoningEffortSetting,
  UpdateProjectRequest,
} from '@shared/chat';
import { normalizeSessionTitle } from '@shared/chat';
import { isUntouchedImport } from './grouping';
import type { CreatedSession } from '@shared/ipc';
import type { ModelRuntimeStatus } from '@shared/models';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { appendArrived, OPTIMISTIC_ID_PREFIX } from './arrivedMessage';
import { addDirPath } from './commands';
import { describeReturn } from './queuedMessages';
import { applyLiveEvent, coalesceLiveEvents, startReply, type LiveReplyEvent } from '@shared/liveReply';
import { applyReplyDone } from './replyDone';
import { applyStatusEvents } from './sessionStatus';
import { EVENT_STAMP_RESOLUTION_MS, REASONING_TAIL_CHARS, totalTokens, type TurnProgress } from './statusLine';
import { applyWorkspaceEvent, preparingOnSend, type WorkspaceProgress } from './workspaceProgress';
import { canHoldWorktree, worktreeByDefault } from './worktreeDefault';
import { parseDirectoryOutcome, REQUEST_DIRECTORY_TOOL_NAME } from '@shared/directoryRequest';

const LIVE_FLUSH_FALLBACK_MS = 100;

export interface SessionsController {
  sessions: ChatSessionSummary[];
  loading: boolean;
  reload: () => Promise<void>;
  create: (placement?: SessionPlacement) => Promise<string>;
  /** Start a Code session. Resolves null when main refused; `codeError` then says why. */
  createCode: (request: CreateCodeSessionRequest, placement?: SessionPlacement) => Promise<string | null>;
  /** Set while a Code session is being created - resolving a worktree can take a moment. */
  creatingCode: boolean;
  codeError: string | null;
  clearCodeError: () => void;
  remove: (sessionId: string, removeWorktree?: boolean) => Promise<void>;
  togglePin: (session: ChatSessionSummary) => Promise<void>;
  toggleArchived: (session: ChatSessionSummary) => Promise<void>;
  /** Rename any listed session, shown at once and rolled back (with `renameError`) if main refuses. */
  rename: (session: ChatSessionSummary, title: string) => Promise<void>;
  renameError: string | null;
  clearRenameError: () => void;
  /** Apply a summary main just returned, so the sidebar reorders without a full reload. */
  apply: (summary: ChatSessionSummary) => void;
}

/** A user sidebar section to start a session in; see CreateSessionRequest. */
export interface SessionPlacement {
  sectionId: string;
  /** Gets main's section state in the same update that adds the row, so it is drawn in place. */
  placed: (sections: SidebarSectionsState) => void;
  /** Main could not save the placement; the row still exists and starts in the default groups. */
  failed: () => void;
}

export function useSessions(): SessionsController {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [creatingCode, setCreatingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const latestReload = useRef(0);
  const localEdits = useRef(0);
  // A listing that resolves after a newer listing, or after a local edit (create, pin, rename),
  // would put back the rows it read before them. Import syncs re-list often enough to hit this.
  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++latestReload.current;
    const editsBefore = localEdits.current;
    const next = await window.b4m.chat.listSessions();
    if (ticket !== latestReload.current) return;
    if (editsBefore !== localEdits.current) return reload();
    setSessions(next);
    setLoading(false);
  }, []);
  const editSessions = useCallback((update: (current: ChatSessionSummary[]) => ChatSessionSummary[]) => {
    localEdits.current++;
    setSessions(update);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Main batches these, so a sync of hundreds of transcripts re-lists a handful of times.
  useEffect(() => window.b4m.claudeImport?.onSessionsChanged(() => void reload()), [reload]);

  // Failed spawns are deleted without a reply ending or a status push to refresh the list.
  useEffect(
    () =>
      window.b4m.chat.onStreamEvent(event => {
        if (event.type === 'spawn-failed') void reload();
      }),
    [reload]
  );

  // Patched in place rather than moved to the front, the way pinning is: a generated title does
  // not touch `updatedAt`, so reordering here would disagree with the next reload. An id this
  // window does not hold is ignored - the push reaches every window, including ones that have
  // not listed that session yet.
  useEffect(() => {
    return window.b4m.chat.onSessionSummary(summary => {
      editSessions(current => current.map(entry => (entry.id === summary.id ? summary : entry)));
    });
  }, []);

  // The section state and the new row are set in one synchronous block, so React renders them
  // together and the row never shows in the default groups on its way into its section.
  const list = useCallback((created: CreatedSession, placement: SessionPlacement | undefined) => {
    if (created.sidebarSections) placement?.placed(created.sidebarSections);
    else if (created.placementFailed) placement?.failed();
    editSessions(current => [created.session, ...current]);
  }, []);

  const create = useCallback(
    async (placement?: SessionPlacement) => {
      const created = await window.b4m.chat.createSession(placement && { sectionId: placement.sectionId });
      list(created, placement);
      return created.session.id;
    },
    [list]
  );

  const createCode = useCallback(
    async (request: CreateCodeSessionRequest, placement?: SessionPlacement) => {
      setCreatingCode(true);
      setCodeError(null);
      try {
        const result = await window.b4m.chat.createCodeSession(
          placement ? { ...request, sectionId: placement.sectionId } : request
        );
        if (!result.ok) {
          setCodeError(result.error);
          return null;
        }
        list(result, placement);
        return result.session.id;
      } finally {
        setCreatingCode(false);
      }
    },
    [list]
  );

  const remove = useCallback(async (sessionId: string, removeWorktree = false) => {
    await window.b4m.chat.deleteSession(sessionId, removeWorktree);
    editSessions(current => current.filter(session => session.id !== sessionId));
  }, []);

  const apply = useCallback((summary: ChatSessionSummary) => {
    editSessions(current => [summary, ...current.filter(session => session.id !== summary.id)]);
  }, []);

  // Patched in place rather than moved to the front: pinning does not touch `updatedAt`, so
  // reordering the row here would disagree with what the next reload shows.
  const togglePin = useCallback(async (session: ChatSessionSummary) => {
    const updated = await window.b4m.chat.setSessionPinned(session.id, !session.pinned);
    if (!updated) return;
    editSessions(current => current.map(entry => (entry.id === updated.id ? updated : entry)));
  }, []);

  // Patched in place rather than moved, for the same reason pinning is: archiving does not
  // touch `updatedAt`, and the row is about to change section anyway.
  const toggleArchived = useCallback(async (session: ChatSessionSummary) => {
    const updated = await window.b4m.chat.setSessionArchived(session.id, !session.archived);
    if (!updated) return;
    editSessions(current => current.map(entry => (entry.id === updated.id ? updated : entry)));
  }, []);

  const rename = useCallback(
    async (session: ChatSessionSummary, title: string) => {
      const next = normalizeSessionTitle(title);
      if (!next || next === session.title) return;
      setRenameError(null);
      const retitle = (from: string, to: string) =>
        editSessions(current =>
          current.map(entry => (entry.id === session.id && entry.title === from ? { ...entry, title: to } : entry))
        );
      retitle(session.title, next);
      let updated: ChatSessionSummary | null = null;
      try {
        updated = await window.b4m.chat.renameSession(session.id, next);
      } catch {
        updated = null;
      }
      if (updated) {
        apply(updated);
        return;
      }
      // Only undone if nothing has renamed the row since, so a later name is not clobbered.
      retitle(next, session.title);
      setRenameError(`Could not rename "${session.title}".`);
    },
    [apply]
  );

  const clearCodeError = useCallback(() => setCodeError(null), []);
  const clearRenameError = useCallback(() => setRenameError(null), []);

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
    rename,
    renameError,
    clearRenameError,
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
  /** Local mode only: whether Ollama answers, read with each list. Null until the first answer. */
  runtime?: ModelRuntimeStatus | null;
}

/** How often local mode checks that Ollama still answers (one cheap request) while the window is visible. */
export const LOCAL_STATUS_POLL_MS = 5_000;

/**
 * The models this server offers, refetched when the environment changes.
 *
 * Auth state is the trigger rather than a timer: switching hosted -> self-host changes which
 * providers have keys, so the previous server's list is not just stale but wrong, and leaving
 * it on screen would offer models this deployment will reject.
 *
 * `local` (signed out, device models only) also polls Ollama's status, because it starting,
 * stopping or gaining a model raises no event. The list is reread only when reachability changes
 * or while it is empty.
 */
export function useModelCatalog(local = false): ModelCatalogController {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ModelRuntimeStatus | null>(null);
  const latestLoad = useRef(0);
  const seen = useRef({ empty: true, reachable: null as boolean | null });
  seen.current = { empty: models.length === 0, reachable: runtime?.reachable ?? null };

  const load = useCallback(
    async (force: boolean, quiet = false) => {
      const mine = ++latestLoad.current;
      if (!quiet) setLoading(true);
      const [catalog, status] = await Promise.all([
        window.b4m.chat.listModels(force),
        local ? window.b4m.models.getStatus().catch(() => null) : null,
      ]);
      // A slower, older response must not overwrite a newer one.
      if (mine !== latestLoad.current) return;
      setModels(catalog.models);
      setError(catalog.error ?? null);
      setRuntime(status);
      setLoading(false);
    },
    [local]
  );

  useEffect(() => {
    if (!local) return;
    const check = async () => {
      if (document.hidden) return;
      const status = await window.b4m.models.getStatus().catch(() => null);
      if (!status) return;
      const { empty, reachable } = seen.current;
      if (status.reachable !== reachable || (status.reachable && empty)) await load(true, true);
    };
    const tick = () => void check();
    const timer = setInterval(tick, LOCAL_STATUS_POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [local, load]);

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

  // A model pulled or removed on the Models screen changes the local half of the list.
  useEffect(() => window.b4m.models.onInstalledChanged(() => void load(true)), [load]);

  const reload = useCallback(() => load(true), [load]);

  return { models, loading, error, reload, runtime };
}

export interface ProjectBindingError {
  message: string;
  /** Refused on timing rather than validity: the same change works once the session is idle. */
  busy: boolean;
  /** A toggle-off pick of a branch another worktree holds; the chip row offers the ways on. */
  elsewhere?: BranchElsewhere;
}

/** Everything the chip row above the composer can change about a Code session's grounding. */
export interface ProjectBindingController {
  /** Set while a change is in flight - resolving a worktree can take a moment. */
  busy: boolean;
  error: ProjectBindingError | null;
  dismissError: () => void;
  /** Open the folder picker, then re-root the session on whatever is chosen. */
  pickDirectory: () => Promise<void>;
  /** Re-root the session on a folder already known, such as a recent one: no picker. */
  chooseDirectory: (directory: string) => Promise<void>;
  setBranch: (branch: string) => Promise<void>;
  setWorkspace: (workspace: boolean) => Promise<void>;
  /** Move the session into the worktree that already has `elsewhere.branch` checked out. */
  moveToCheckout: (elsewhere: BranchElsewhere) => Promise<void>;
  /** Turn the worktree toggle on with `branch` as the base the first message cuts from. */
  worktreeFrom: (branch: string) => Promise<void>;
  addContextDirectory: () => Promise<void>;
  removeContextDirectory: (directory: string) => Promise<void>;
}

export interface ConversationController {
  session: ChatSession | null;
  setHistory: (enabled: boolean) => Promise<void>;
  messages: ChatMessage[];
  /** Set while a reply for THIS session is streaming. */
  streaming: boolean;
  /** Elapsed clock and server-reported cost of the turn in flight; null when none is. */
  turn: TurnProgress | null;
  /** What the model is doing in the round in flight; null between rounds and outside a turn. */
  phase: ModelPhase | null;
  /** A first turn waiting on its worktree, before `turn` exists. Null otherwise. */
  preparing: WorkspaceProgress | null;
  sendError: string | null;
  /** One-shot message about something main changed while accepting a turn. Not a failure. */
  notice: string | null;
  dismissNotice: () => void;
  /** False when main refused the turn; the text is already back in the composer. */
  send: (text: string, attachments?: readonly ChatAttachment[]) => Promise<boolean>;
  /** Device-local: move a conversation whose model is not installed to the one a send would use. */
  settleLocalModel: () => Promise<void>;
  stop: () => void;
  /** Resume the last reply if the agent loop's budget cut it short. */
  continueReply: () => Promise<void>;
  /**
   * Run a slash command. Client-side actions only; nothing here reaches the model as a tool.
   * A refusal lands in `sendError`, which is where the user is already looking for one.
   */
  runCommand: (name: string, args: string) => Promise<void>;
  /** What a running command is doing, for the progress line. Null when none is. */
  commandProgress: string | null;
  /** Messages typed ahead of the live turn, oldest first. Empty unless one is streaming. */
  queued: ChatQueuedMessage[];
  /** Take one back. Its text returns through `returned`, which is also how it is edited. */
  cancelQueued: (queuedId: string) => void;
  /**
   * Stop the live reply and run this queued message next instead of waiting for it. Unlike
   * `stop`, the rest of the queue is kept rather than handed back.
   */
  sendQueuedNow: (queuedId: string) => void;
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
  /** How hard that model should think. Sent only on a model that accepts an effort. */
  setReasoningEffort: (effort: ReasoningEffortSetting) => Promise<void>;
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
  const [phase, setPhase] = useState<ModelPhase | null>(null);
  const [preparing, setPreparing] = useState<WorkspaceProgress | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<ProjectBindingError | null>(null);
  const [queued, setQueued] = useState<ChatQueuedMessage[]>([]);
  const [returned, setReturned] = useState<{ id: number; messages: ChatQueuedMessage[] } | null>(null);
  const [settledTurns, setSettledTurns] = useState(0);
  const [commandProgress, setCommandProgress] = useState<string | null>(null);
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

  /** The session this window has a send out for, read by the subscription; see applyWorkspaceEvent. */
  const sendingFor = useRef<string | null>(null);
  // An imported refresh must not replace a prompt, boundary or reply that arrived after its read began.
  const transcriptVersion = useRef(0);
  const workspaceVersion = useRef(0);
  const historyVersion = useRef(0);

  useEffect(() => {
    setSendError(null);
    setNotice(null);
    setProjectError(null);
    setReturned(null);
    setQueued([]);
    setCommandProgress(null);
    setPreparing(null);
    setPhase(null);
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      setStreaming(false);
      setTurn(null);
      return;
    }

    let current = true;
    const load = (): void => {
      const preparationBeforeRead = workspaceVersion.current;
      const historyBeforeRead = historyVersion.current;
      void window.b4m.chat.getSession(sessionId).then(loaded => {
        if (!current) return;
        if (preparationBeforeRead !== workspaceVersion.current) return load();
        if (historyBeforeRead !== historyVersion.current) return load();
        // A reply already running arrives as main's live copy, and the events from now on
        // extend it. One that settled while this read was in flight is stale: read again
        // rather than put back a turn the 'done' already closed.
        const live = loaded?.replyInFlight;
        if (live && settledReplies.current.has(live.messageId)) return load();
        setSession(loaded);
        setMessages(loaded?.messages ?? []);
        // A started session opened while its worktree is still being cut: no event is coming
        // to say so, the 'workspace' one went out before this window was looking.
        setPreparing(current => current ?? loaded?.preparingWorkspace ?? null);
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

  const followsImport = !!session && isUntouchedImport(session);
  useEffect(() => {
    if (!sessionId || !followsImport) return;
    let current = true;
    let latestRead = 0;
    const refresh = async () => {
      if (sendingFor.current === sessionId) return;
      const ticket = ++latestRead;
      const version = transcriptVersion.current;
      try {
        const loaded = await window.b4m.chat.getSession(sessionId);
        if (!current || ticket !== latestRead || version !== transcriptVersion.current) return;
        if (sendingFor.current === sessionId || !loaded || loaded.replyInFlight || !isUntouchedImport(loaded)) return;
        setMessages(loaded.messages);
        // Keep local controls such as model and folder choices; sync only replaced the transcript.
        setSession(previous =>
          previous
            ? {
                ...previous,
                title: previous.titleLocked ? previous.title : loaded.title,
                importOrigin: loaded.importOrigin,
                messages: loaded.messages,
                updatedAt: loaded.updatedAt,
              }
            : previous
        );
      } catch (error) {
        if (!current || ticket !== latestRead || version !== transcriptVersion.current) return;
        setSendError(
          `Could not refresh this imported conversation. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    };
    const off = window.b4m.claudeImport?.onSessionsChanged(() => void refresh());
    return () => {
      current = false;
      off?.();
    };
  }, [sessionId, followsImport]);

  // The header reads the open conversation's own copy of the title, so the sidebar's patch is
  // not enough: without this, the row renames itself and the heading above the thread does not.
  useEffect(() => {
    return window.b4m.chat.onSessionSummary(summary => {
      if (summary.id !== activeSessionId.current) return;
      historyVersion.current++;
      // The project too: a worktree landing under an open session is pushed this way, and the
      // chips have to stop saying it is on its way.
      setSession(current =>
        current
          ? { ...current, title: summary.title, project: summary.project, historyEnabled: summary.historyEnabled }
          : current
      );
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
    let fallback: ReturnType<typeof setTimeout> | undefined;
    // What the model is thinking right now, kept out of the thread - see TurnProgress.reasoning.
    let reasoning = '';
    const flushLive = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
      frame = undefined;
      fallback = undefined;
      if (queued.length === 0) return;
      const events = coalesceLiveEvents(queued);
      queued = [];
      setMessages(current =>
        current.map(message => events.reduce((folded, event) => applyLiveEvent(folded, event), message))
      );
      // The turn's sign of life, stamped once per FLUSH rather than once per event: the batch
      // above exists so a fast stream does not re-render per token, and a stamp per token would
      // hand that straight back. Coarser still at a second, where the same object is returned
      // and React re-renders nothing at all - see EVENT_STAMP_RESOLUTION_MS.
      reasoning = '';
      setTurn(current => {
        if (!current) return current;
        const stamped = Date.now();
        const due = stamped - (current.lastEventAt ?? current.startedAt) >= EVENT_STAMP_RESOLUTION_MS;
        // Text or a tool means the model stopped thinking and started doing, so the reasoning
        // goes immediately rather than waiting for the next stamp to come due.
        if (!due && current.reasoning === undefined) return current;
        return { ...current, reasoning: undefined, ...(due ? { lastEventAt: stamped } : {}) };
      });
    };

    const unsubscribe = window.b4m.chat.onStreamEvent(event => {
      if (event.sessionId === activeSessionId.current) transcriptVersion.current++;
      const live =
        event.type === 'delta' ||
        event.type === 'tool-start' ||
        event.type === 'tool-end' ||
        event.type === 'tool-progress';
      if (live) {
        if (event.sessionId !== activeSessionId.current) return;
        // A folder the user just added has to show up in the chips at once - that row is where it
        // is revoked - and main pushes no summary for it.
        if (
          event.type === 'tool-end' &&
          event.call.name === REQUEST_DIRECTORY_TOOL_NAME &&
          parseDirectoryOutcome(event.call.input.outcome)?.status === 'granted'
        ) {
          const granted = event.sessionId;
          void window.b4m.chat.getSession(granted).then(loaded => {
            if (!loaded || activeSessionId.current !== granted) return;
            setSession(current =>
              current?.id === granted
                ? { ...current, project: loaded.project, grantedDirectories: loaded.grantedDirectories }
                : current
            );
          });
        }
        // The call has arrived, so the tool's own status takes over; the next round sends a phase anew.
        if (event.type === 'tool-start') setPhase(null);
        queued.push(event);
        frame ??= requestAnimationFrame(flushLive);
        // rAF is paused in a hidden or occluded window; without this the reply stalls until the
        // next non-live event or until the window is shown again.
        fallback ??= setTimeout(flushLive, LIVE_FLUSH_FALLBACK_MS);
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

      if (event.type === 'phase') {
        setPhase(event.phase);
        // A sign of life like any other frame: a thinking marker carries no text to stamp it.
        setTurn(current => (current ? { ...current, lastEventAt: Date.now() } : current));
        return;
      }

      if (event.type === 'start') {
        workspaceVersion.current++;
        setPhase(null);
        setPreparing(null);
        setStreaming(true);
        reasoning = '';
        const startedAt = Date.now();
        setTurn({ startedAt, tokens: null, lastEventAt: startedAt });
        setMessages(current => startReply(current, event.messageId));
        return;
      }

      // Reasoning is a sign of life and nothing else: it is deliberately not folded into the
      // message, because the thread does not draw it. Published at the same coarse rate as the
      // stamp, so a model emitting thinking tokens as fast as it can write cannot pull this
      // window into a re-render per token.
      if (event.type === 'reasoning') {
        reasoning = (reasoning + event.text).slice(-REASONING_TAIL_CHARS);
        setTurn(current => {
          if (!current) return current;
          const stamped = Date.now();
          const previous = current.lastEventAt ?? current.startedAt;
          if (current.reasoning !== undefined && stamped - previous < EVENT_STAMP_RESOLUTION_MS) return current;
          return { ...current, lastEventAt: stamped, reasoning };
        });
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

      // A message that arrived without anyone typing it - a spawned session reporting back, or
      // a compaction's boundary. Appended rather than folded into a streaming reply: it belongs
      // to no turn in flight.
      if (event.type === 'message') {
        setMessages(current =>
          current.some(message => message.id === event.message.id) ? current : appendArrived(current, event.message)
        );
        return;
      }

      if (event.type === 'workspace') {
        workspaceVersion.current++;
        const sending = sendingFor.current === event.sessionId;
        setPreparing(current => applyWorkspaceEvent(current, event, Date.now(), sending));
        return;
      }

      if (event.type === 'auto-compact') {
        setCommandProgress(event.running ? 'Context limit reached - compacting before your message goes out...' : null);
        if (event.error) {
          setNotice(
            `Could not compact automatically, so your message went out with the whole conversation. ${event.error}`
          );
        }
        return;
      }

      if (event.type === 'context-notice') {
        setNotice(event.message);
        return;
      }

      if (event.type === 'context-trimmed') {
        setNotice(
          `This conversation no longer fits the model's context, so ${event.dropped === 1 ? 'its oldest message was' : `its ${event.dropped} oldest messages were`} left out of this reply. Your next message compacts it first, or run /compact now.`
        );
        return;
      }

      // Only 'done' and 'error' end a reply. Stated rather than left to the fall-through,
      // because the background-process events arrive with no reply in flight at all, and
      // treating an unrecognised event as terminal would blank the streaming indicator.
      if (event.type !== 'done' && event.type !== 'error') return;

      setStreaming(false);
      setTurn(null);
      setPhase(null);
      setMessages(current => {
        // Absent when this window opened in the gap between main dropping its live copy and
        // storing the reply; the terminal event is then the only copy it will get.
        const base = current.some(message => message.id === event.messageId)
          ? current
          : startReply(current, event.messageId);
        return base.map(message => {
          if (message.id !== event.messageId) return message;
          if (event.type === 'done') return applyReplyDone(message, event);
          return {
            ...message,
            error: event.message,
            contextSnapshot: event.contextSnapshot,
            ...(event.stopReason ? { stopReason: event.stopReason } : {}),
          };
        });
      });
    });

    return () => {
      unsubscribe();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
    };
  }, []);

  const sessionProject = session?.project;
  const send = useCallback(
    async (text: string, attachments: readonly ChatAttachment[] = []): Promise<boolean> => {
      if (!sessionId) return true;
      const prompt = text.trim();
      // An attachment on its own is a turn; only a turn with neither is not.
      if (!prompt && attachments.length === 0) return true;

      transcriptVersion.current++;
      setSendError(null);
      setNotice(null);

      // A turn already being prepared counts as one in flight: main queues behind it.
      const goingOut = !streaming && !preparing;
      const localPreparing = preparingOnSend(sessionProject, !goingOut, Date.now());
      if (localPreparing) setPreparing(localPreparing);

      // Drawn before the round trip so the thread answers the keystroke immediately - but only
      // when this turn is going out now. Main decides queueing, so `streaming` is a guess here;
      // it is only ever wrong in the gap where a reply has just ended, and the result below
      // corrects it either way. A queued message must NOT appear in the transcript: that would
      // claim it had been sent, which is the one thing it has not been.
      const optimistic: ChatMessage | null = goingOut
        ? {
            // Temporary: main assigns the persisted id. They meet again on the next load, which
            // is the only place the difference could show, and by then this one is gone.
            id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}`,
            role: 'user',
            content: prompt,
            createdAt: new Date().toISOString(),
            ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          }
        : null;
      if (optimistic) setMessages(current => [...current, optimistic]);

      const discardOptimistic = () => {
        if (optimistic) setMessages(current => current.filter(message => message.id !== optimistic.id));
      };

      if (goingOut) sendingFor.current = sessionId;
      const result = await window.b4m.chat
        .sendMessage({
          sessionId,
          text: prompt,
          ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
        })
        .finally(() => {
          if (!goingOut) return;
          if (sendingFor.current === sessionId) sendingFor.current = null;
          // Whatever the outcome: a refused turn has no 'start' coming to clear it.
          if (activeSessionId.current === sessionId) setPreparing(null);
        });
      if (!result.ok) {
        discardOptimistic();
        setSendError(result.error);
        // The box was cleared on send; a refused turn must not cost the user what they typed.
        if (prompt)
          setReturned({
            id: ++returnBatch.current,
            messages: [{ id: 'refused', sessionId, text: prompt, queuedAt: new Date().toISOString() }],
          });
        return false;
      }
      // It queued after all: the pending row above the composer is where it lives now.
      if (result.queued) {
        discardOptimistic();
        return true;
      }
      if (result.notice) setNotice(result.notice);
      // It went out although this window thought a reply was running - the turn that was
      // streaming had already ended. The thread has to show the prompt that is now in it.
      if (!optimistic) {
        setMessages(current => [
          ...current,
          {
            id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}`,
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
        const { messages: _messages, spawnSuggestions: _suggestions, ...rest } = summary;
        onSummaryChanged({ ...rest, messageCount: summary.messages.length });
      }
      return true;
    },
    [sessionId, streaming, preparing, sessionProject, onSummaryChanged]
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

  // A summary main just wrote, folded into both the open conversation and the sidebar row.
  const applySummary = useCallback(
    (updated: ChatSessionSummary) => {
      setSession(current =>
        current ? { ...current, project: updated.project, grantedDirectories: updated.grantedDirectories } : current
      );
      onSummaryChanged(updated);
    },
    [onSummaryChanged]
  );

  /**
   * The chip's picker when `path` is absent, `/add-dir <path>` when present. Both go through the
   * one main-side share, so neither can grant what the other would refuse. A refusal lands in
   * `sendError`; `confirm` adds a line for an addition the user typed, since a typed command has
   * no button whose result they are already looking at.
   */
  const shareDirectory = useCallback(
    async (path: string | undefined, confirm: boolean) => {
      if (!sessionId) return;
      const result = await window.b4m.chat.addContextDirectory(sessionId, path);
      if (result.status === 'cancelled') return;
      if (result.status === 'refused') {
        setSendError(result.error);
        return;
      }
      if (result.status === 'already') {
        setNotice(`${result.path} is already shared with this conversation.`);
        return;
      }
      applySummary(result.session);
      if (confirm || result.warning) {
        setNotice([`Shared ${result.path} with this conversation.`, result.warning].filter(Boolean).join(' '));
      }
    },
    [sessionId, applySummary]
  );

  /**
   * Run `/clear`, `/compact`, `/pr` or `/add-dir`.
   *
   * Main owns both outcomes. The streaming check that refuses a compaction is made THERE for the
   * reason queueing is: a turn that ends between a renderer-side check and the IPC call would
   * otherwise let a summary be written against a conversation that had just grown.
   *
   * The message list is replaced from the session main returns, rather than patched here. A
   * failure replaces nothing at all, which is the contract `/compact` turns on - see
   * ChatService.compactContext.
   */
  const runCommand = useCallback(
    async (name: string, args: string) => {
      if (!sessionId) return;
      transcriptVersion.current++;
      setSendError(null);
      setNotice(null);
      if (name === 'pr') {
        const bound = args
          ? await window.b4m.pullRequests.bind(sessionId, args)
          : {
              ok: false as const,
              error: 'Paste the PR URL after /pr, e.g. /pr https://github.com/owner/repo/pull/123',
            };
        if (!bound.ok) setSendError(bound.error);
        return;
      }
      if (name === 'add-dir') {
        await shareDirectory(addDirPath(args), true);
        return;
      }
      setCommandProgress(name === 'compact' ? 'Summarising this conversation...' : null);
      try {
        const result =
          name === 'compact'
            ? await window.b4m.chat.compactContext(sessionId, args)
            : await window.b4m.chat.clearContext(sessionId);
        if (!result.ok) {
          setSendError(result.error);
          return;
        }
        setSession(result.session);
        setMessages(result.session.messages);
      } finally {
        setCommandProgress(null);
      }
    },
    [sessionId, shareDirectory]
  );

  const cancelQueued = useCallback(
    (queuedId: string) => {
      if (sessionId) void window.b4m.chat.cancelQueuedMessage(sessionId, queuedId);
    },
    [sessionId]
  );

  // No optimistic update: main owns the queue and pushes the result, and the turn may well
  // have finished on its own by the time this lands, which makes it a no-op there.
  const sendQueuedNow = useCallback(
    (queuedId: string) => {
      if (sessionId) void window.b4m.chat.sendQueuedMessageNow(sessionId, queuedId);
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

  const settleLocalModel = useCallback(async () => {
    if (!sessionId) return;
    const settled = await window.b4m.chat.settleLocalModel(sessionId);
    if (!settled || activeSessionId.current !== sessionId) return;
    if (settled.notice) setNotice(settled.notice);
    setSession(current => (current?.id === sessionId ? { ...current, model: settled.session.model } : current));
    onSummaryChanged(settled.session);
  }, [sessionId, onSummaryChanged]);

  const setHistory = useCallback(
    async (enabled: boolean) => {
      if (!sessionId || session?.id !== sessionId) return;
      const version = historyVersion.current;
      try {
        const updated = await window.b4m.chat.setSessionHistory(sessionId, enabled);
        if (!updated || version !== historyVersion.current) return;
        setSession(current =>
          current?.id === sessionId ? { ...current, historyEnabled: updated.historyEnabled } : current
        );
        onSummaryChanged(updated);
      } catch (error) {
        setNotice(`Could not update local history. ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [sessionId, session?.id, onSummaryChanged]
  );

  const setReasoningEffort = useCallback(
    async (effort: ReasoningEffortSetting) => {
      if (!sessionId) return;
      const updated = await window.b4m.chat.setSessionReasoningEffort(sessionId, effort);
      if (!updated) return;
      setSession(current => (current ? { ...current, reasoningEffort: updated.reasoningEffort } : current));
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

  /** Resolves true when the session really moved, so a caller can report what happened after. */
  const changeProject = useCallback(
    async (change: Omit<UpdateProjectRequest, 'sessionId'>) => {
      if (!sessionId) return false;
      setProjectBusy(true);
      setProjectError(null);
      try {
        const result = await window.b4m.chat.updateProject({ sessionId, ...change });
        if (!result.ok) {
          setProjectError({
            message: result.error,
            busy: !!result.busy,
            ...(result.elsewhere ? { elsewhere: result.elsewhere } : {}),
          });
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

  const chooseDirectory = useCallback(
    async (directory: string) => {
      setProjectError(null);
      const inspected = await window.b4m.chat.inspectProject(directory);
      // A folder nothing could run in is reported instead of being bound. Main refuses it too,
      // so this only spares the user a move that would come back as the same sentence.
      if (inspected.refusal) {
        setProjectError({ message: inspected.refusal, busy: false });
        return;
      }
      // The workspace choice does not travel: it named a worktree of the repository being left,
      // and carrying it across would create one in a repository the user has only just pointed at.
      // The new folder starts from the user's default instead; see worktreeDefault.ts.
      const moved = await changeProject({
        directory,
        branch: inspected.currentBranch ?? '',
        workspace: worktreeByDefault() && canHoldWorktree(inspected),
      });
      // The folder is still usable when git could not be read - it just has no branches to offer -
      // so this is reported after the move rather than instead of it.
      if (moved && inspected.error) setProjectError({ message: inspected.error, busy: false });
    },
    [changeProject]
  );

  const pickDirectory = useCallback(async () => {
    setProjectError(null);
    const directory = await window.b4m.chat.pickProjectDirectory();
    if (directory) await chooseDirectory(directory);
  }, [chooseDirectory]);

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
  // A move like pickDirectory's, onto a folder git has just named rather than one the picker did.
  const moveToCheckout = useCallback(
    async ({ path, branch }: BranchElsewhere) => {
      await changeProject({ directory: path, branch, workspace: false });
    },
    [changeProject]
  );
  const worktreeFrom = useCallback(
    async (branch: string) => {
      await changeProject({ branch, workspace: true });
    },
    [changeProject]
  );

  const addContextDirectory = useCallback(async () => {
    setProjectError(null);
    setSendError(null);
    setNotice(null);
    await shareDirectory(undefined, false);
  }, [shareDirectory]);

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
      chooseDirectory,
      setBranch,
      setWorkspace,
      moveToCheckout,
      worktreeFrom,
      addContextDirectory,
      removeContextDirectory,
    }),
    [
      projectBusy,
      projectError,
      dismissProjectError,
      pickDirectory,
      chooseDirectory,
      setBranch,
      setWorkspace,
      moveToCheckout,
      worktreeFrom,
      addContextDirectory,
      removeContextDirectory,
    ]
  );

  return {
    session,
    setHistory,
    messages,
    streaming,
    turn,
    phase,
    preparing,
    sendError,
    notice,
    dismissNotice,
    send,
    stop,
    continueReply,
    runCommand,
    commandProgress,
    queued,
    cancelQueued,
    sendQueuedNow,
    returned,
    clearReturned,
    settledTurns,
    rename,
    setModel,
    settleLocalModel,
    setReasoningEffort,
    setApprovalMode,
    project,
    respondToApproval,
  };
}
