import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptCacheTtl } from '@bike4mind/common';
import type {
  ActiveContextNotice,
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
  ChatStreamEvent,
  ContextNoticeKind,
  CreateCodeSessionRequest,
  ModelPhase,
  ReasoningEffortSetting,
  SendMessageResult,
  SessionBackgroundJobs,
  SessionSetupStep,
  UpdateProjectRequest,
} from '@shared/chat';
import { carriedNotes, regenerableReply } from '@shared/threadRewind';
import { summarizeSession } from '@shared/agentOutcome';
import { HELD_CONTEXT_NOTICE_KINDS, normalizeSessionTitle } from '@shared/chat';
import { hostChat } from '../host/hostChat';
import { isUntouchedImport } from './grouping';
import type { GenerationSettings } from '@shared/generation';
import type { CreatedSession } from '@shared/ipc';
import { LOCAL_HOST_ID } from '@shared/hostBridge';
import { hostClient } from '../host/HostClient';
import { sessionEvents } from '../host/sessionEvents';
import { hostForSession } from '../host/sessionHost';
import { useHostResync } from '../host/useSessionEvents';
import { useSettledTurns } from './useSettledTurns';
import { SESSION_PAGE_MAX_LIMIT, SESSION_PAGE_SIZE, SESSION_SEARCH_LIMIT } from '@shared/sessionPage';
import { keepRequest, NO_PAGING, sessionsFromPage, withRows, type SessionPaging } from './sessionPages';
import type { ModelRuntimeStatus } from '@shared/models';
import type { SidebarSectionsState } from '@shared/sidebarSections';
import { appendArrived, OPTIMISTIC_ID_PREFIX } from './arrivedMessage';
import { addDirPath } from './commands';
import { forgetSessionPrefs } from './orchestrator/orchestratorPrefs';
import { describeReturn } from './queuedMessages';
import { applyLiveEvent, coalesceLiveEvents, startReply, type LiveReplyEvent } from '@shared/liveReply';
import { applyReplyDone } from './replyDone';
import { withPhase } from './replyStats';
import {
  applyBackgroundEvents,
  applyPreparingEvents,
  applyStatusEvents,
  applyUnreadReplyEvents,
} from './sessionStatus';
import { EVENT_STAMP_RESOLUTION_MS, REASONING_TAIL_CHARS, totalTokens, type TurnProgress } from './statusLine';
import { applyWorkspaceEvent, preparingOnSend, type WorkspaceProgress } from './workspaceProgress';
import { canHoldWorktree, worktreeByDefault } from './worktreeDefault';
import { parseDirectoryOutcome, REQUEST_DIRECTORY_TOOL_NAME } from '@shared/directoryRequest';
import { StreamResumeGate } from './streamResume';

const LIVE_FLUSH_FALLBACK_MS = 100;
const MAX_SETTLED_REREADS = 3;

export interface SessionsController {
  sessions: ChatSessionSummary[];
  loading: boolean;
  reload: () => Promise<void>;
  create: (placement?: SessionPlacement) => Promise<string>;
  /** Start the Studio place's own conversation, which no sidebar lists. */
  createStudio: () => Promise<string>;
  /** Start a Code session. Resolves null when main refused; `codeError` then says why. */
  createCode: (request: CreateCodeSessionRequest, placement?: SessionPlacement) => Promise<string | null>;
  /** Set while a Code session is being created - resolving a worktree can take a moment. */
  creatingCode: boolean;
  codeError: string | null;
  clearCodeError: () => void;
  /**
   * With `nestedIds`, deletes those nested sessions first. Resolves the ids deleted; a failure part
   * way throws an error whose `deleted` lists the ones already gone.
   */
  remove: (
    sessionId: string,
    removeWorktree?: boolean,
    nestedIds?: readonly string[],
    nestedWorktreeIds?: readonly string[]
  ) => Promise<string[]>;
  togglePin: (session: ChatSessionSummary) => Promise<void>;
  toggleArchived: (session: ChatSessionSummary) => Promise<void>;
  /** Rename any listed session, shown at once and rolled back (with `renameError`) if main refuses. */
  rename: (session: ChatSessionSummary, title: string) => Promise<void>;
  renameError: string | null;
  clearRenameError: () => void;
  /** Save a conversation to a file the user picks; a failure sets `exportError`. */
  exportSession: (session: ChatSessionSummary) => Promise<void>;
  exportError: string | null;
  clearExportError: () => void;
  /** Apply a summary main just returned, so the sidebar reorders without a full reload. */
  apply: (summary: ChatSessionSummary) => void;
  /** More sessions exist past the pages loaded so far. */
  hasMore: boolean;
  /** A next page is on its way. */
  loadingMore: boolean;
  /** Load the next page; does nothing while one is in flight or once there is no more. */
  loadMore: () => void;
  /** Sessions in the whole list, loaded or not. */
  total: number;
  /** Title matches across the whole list, loaded or not, newest first. */
  searchSessions: (query: string) => Promise<{ sessions: ChatSessionSummary[]; total: number }>;
}

/** A user sidebar section to start a session in; see CreateSessionRequest. */
export interface SessionPlacement {
  sectionId: string;
  /** Gets main's section state in the same update that adds the row, so it is drawn in place. */
  placed: (sections: SidebarSectionsState) => void;
  /** Main could not save the placement; the row still exists and starts in the default groups. */
  failed: () => void;
}

/** Newest context notice of each kind per conversation that was not open when it arrived; shown when it opens. */
const backgroundNotices = new Map<string, ContextNotice[]>();

// Refused prompts of a conversation that was not open when the refusal arrived; returned to its composer when it opens.
const backgroundReturned = new Map<string, ChatQueuedMessage[]>();

interface ContextNotice {
  message: string;
  kind?: ContextNoticeKind;
}

/** A notice replaces the earlier one of its kind; one without a kind replaces only an identical message. */
function addNotice(current: ContextNotice[] | undefined, next: ContextNotice): ContextNotice[] {
  const list = current ?? [];
  const at = list.findIndex(item =>
    next.kind ? item.kind === next.kind : !item.kind && item.message === next.message
  );
  if (at === -1) return [...list, next];
  return list.map((item, index) => (index === at ? next : item));
}

/**
 * The held notices replaced by the ones a session read says are in force, so a warning withdrawn
 * while this window was not hearing is gone and one set meanwhile shows; the rest are kept.
 */
function withHeldNotices(current: ContextNotice[], held: readonly ActiveContextNotice[]): ContextNotice[] {
  const passing = current.filter(item => !item.kind || !HELD_CONTEXT_NOTICE_KINDS.includes(item.kind));
  return held.reduce<ContextNotice[]>((list, notice) => addNotice(list, notice), passing);
}

const noticeText = (notices: ContextNotice[]): string | null =>
  notices.length > 0 ? notices.map(item => item.message).join('\n') : null;

/**
 * The session list, loaded a page at a time (see shared/sessionPage): `sessions` holds the pages
 * loaded so far plus the rows main carries with them - pinned and live sessions, each row's spawn
 * family - and `keepIds`, which the shell passes for the open session and the one it restores, so
 * a lookup by id finds them wherever they sit in the list.
 */
export function useSessions(keepIds: readonly string[] = []): SessionsController {
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [paging, setPaging] = useState<SessionPaging>(NO_PAGING);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagingRef = useRef(paging);
  pagingRef.current = paging;
  const pageInFlight = useRef(false);
  const keep = useRef(keepIds);
  keep.current = keepIds;
  const [creatingCode, setCreatingCode] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const latestReload = useRef(0);
  const latestListing = useRef<Promise<void>>(Promise.resolve());
  const localEdits = useRef(0);
  // A listing that resolves after a newer listing, or after a local edit (create, pin, rename),
  // would put back the rows it read before them. Import syncs re-list often enough to hit this.
  // An overtaken reload still resolves only once the newer listing is applied: a caller that
  // selects a session it just created (useSessionDraft) relies on the list holding it by then.
  const reload = useCallback((): Promise<void> => {
    const ticket = ++latestReload.current;
    const editsBefore = localEdits.current;
    // Re-reads every page loaded so far in one request, so scrolled-to rows stay put. Past the
    // request cap the list is cut back to it, so a very deep scroll resets on the next reload.
    const limit = Math.min(Math.max(SESSION_PAGE_SIZE, pagingRef.current.loaded), SESSION_PAGE_MAX_LIMIT);
    const listing = (async (): Promise<void> => {
      const page = await hostClient.request(LOCAL_HOST_ID, 'session/page', {
        limit,
        cursor: null,
        include: keepRequest(keep.current),
      });
      if (ticket !== latestReload.current) return latestListing.current;
      if (editsBefore !== localEdits.current) return reload();
      setSessions(sessionsFromPage(page));
      // The ref is written here too, not only on render: a page reply landing before the next
      // render must already see the moved cursor.
      const next = { loaded: page.sessions.length, nextCursor: page.nextCursor, total: page.total };
      pagingRef.current = next;
      setPaging(next);
      setLoading(false);
    })();
    latestListing.current = listing;
    return listing;
  }, []);
  const editSessions = useCallback((update: (current: ChatSessionSummary[]) => ChatSessionSummary[]) => {
    localEdits.current++;
    setSessions(update);
  }, []);

  // One page in flight at most. A reload started meanwhile wins: it re-reads from the top, and
  // this page's rows would be cut from a listing older than it.
  const loadMore = useCallback(() => {
    const cursor = pagingRef.current.nextCursor;
    if (!cursor || pageInFlight.current) return;
    pageInFlight.current = true;
    setLoadingMore(true);
    const ticket = latestReload.current;
    void (async () => {
      try {
        const page = await hostClient.request(LOCAL_HOST_ID, 'session/page', { limit: SESSION_PAGE_SIZE, cursor });
        // A reload that landed meanwhile moved the cursor; this page was cut from the old list.
        if (ticket !== latestReload.current || pagingRef.current.nextCursor !== cursor) return;
        setSessions(current => withRows(current, [...page.sessions, ...page.related]));
        setPaging(current => ({
          loaded: current.loaded + page.sessions.length,
          nextCursor: page.nextCursor,
          total: page.total,
        }));
      } catch (err) {
        // Left for the next scroll to retry; the list it already shows stays.
        console.warn('Loading more sessions failed', err);
      } finally {
        pageInFlight.current = false;
        setLoadingMore(false);
      }
    })();
  }, []);

  // A kept id outside the loaded pages (a session restored at launch, or opened from a search
  // hit) is fetched on its own. Each id is asked for once, and never once it has been listed: a
  // listed row that leaves the list was deleted, and must not be fetched back.
  const keepKey = keepIds.join('\n');
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    if (loading) return;
    const listed = new Set(sessions.map(session => session.id));
    const missing: string[] = [];
    for (const id of keepIds) {
      if (!askedFor.current.has(id) && !listed.has(id)) missing.push(id);
      askedFor.current.add(id);
    }
    if (missing.length === 0) return;
    void (async () => {
      const page = await hostClient.request(LOCAL_HOST_ID, 'session/page', {
        limit: 0,
        cursor: null,
        include: keepRequest(missing),
      });
      setSessions(current => withRows(current, page.related));
    })().catch(err => console.warn('Loading a session outside the loaded pages failed', err));
  }, [keepKey, loading, sessions]);

  const searchSessions = useCallback(async (query: string) => {
    const page = await hostClient.request(LOCAL_HOST_ID, 'session/page', {
      limit: SESSION_SEARCH_LIMIT,
      cursor: null,
      query,
    });
    return { sessions: page.sessions, total: page.total };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Main batches these, so a sync of hundreds of transcripts re-lists a handful of times.
  useEffect(() => window.b4m.claudeImport?.onSessionsChanged(() => void reload()), [reload]);

  // Failed spawns are deleted without a reply ending or a status push to refresh the list.
  useEffect(
    () =>
      hostClient.onNotification('session/spawnFailed', (_failure, hostId) => {
        if (hostId === LOCAL_HOST_ID) void reload();
      }),
    [reload]
  );

  // A resync or a reconnect may have skipped a summary or spawn push, so the list is read again.
  useHostResync(hostId => {
    if (hostId === LOCAL_HOST_ID) void reload();
  });

  // Patched in place rather than moved to the front, the way pinning is: a generated title does
  // not touch `updatedAt`, so reordering here would disagree with the next reload. An id this
  // window does not hold is ignored - the push reaches every window, including ones that have
  // not listed that session yet.
  useEffect(() => {
    return hostClient.onNotification('session/summaryChanged', ({ summary }, hostId) => {
      if (hostId !== LOCAL_HOST_ID) return;
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

  const createStudio = useCallback(async () => {
    const created = await window.b4m.chat.createSession({ mode: 'studio' });
    list(created, undefined);
    return created.session.id;
  }, [list]);

  const createCode = useCallback(
    async (request: CreateCodeSessionRequest, placement?: SessionPlacement) => {
      setCreatingCode(true);
      setCodeError(null);
      try {
        const result = await hostChat.createCodeSession(
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

  const remove = useCallback(
    async (
      sessionId: string,
      removeWorktree = false,
      nestedIds: readonly string[] = [],
      nestedWorktreeIds: readonly string[] = []
    ) => {
      const forget = (ids: readonly string[]) => {
        for (const id of ids) {
          backgroundNotices.delete(id);
          backgroundReturned.delete(id);
          forgetSessionPrefs(id);
        }
        const gone = new Set(ids);
        editSessions(current => current.filter(session => !gone.has(session.id)));
      };
      if (nestedIds.length === 0) {
        await hostChat.deleteSession(sessionId, { removeWorktree, allowDiscard: true });
        forget([sessionId]);
        return [sessionId];
      }
      const { deleted, error } = await hostChat.deleteSessionTree(
        sessionId,
        [...nestedIds],
        removeWorktree,
        [...nestedWorktreeIds],
        true
      );
      forget(deleted);
      if (error) throw Object.assign(new Error(error), { deleted });
      return deleted;
    },
    []
  );

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
    const updated = await hostChat.setSessionArchived(session.id, !session.archived);
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
        updated = await hostChat.renameSession(session.id, next);
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
  const clearExportError = useCallback(() => setExportError(null), []);

  const exportSession = useCallback(async (session: ChatSessionSummary) => {
    setExportError(null);
    try {
      await window.b4m.chat.exportSession(session.id);
    } catch {
      setExportError(`Could not download "${session.title}".`);
    }
  }, []);

  return {
    sessions,
    loading,
    reload,
    create,
    createStudio,
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
    exportSession,
    exportError,
    clearExportError,
    apply,
    hasMore: paging.nextCursor !== null,
    loadingMore,
    loadMore,
    total: paging.total,
    searchSessions,
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
  return useSessionStatusFeed().statuses;
}

export interface SessionStatusFeed {
  statuses: ReadonlyMap<string, ChatSessionStatus>;
  unreadReplies: ReadonlySet<string>;
  /** Busy sessions still being prepared, by setup step; a subset of the 'processing' ones in `statuses`. */
  preparing: ReadonlyMap<string, SessionSetupStep>;
  /** Running wake-on-exit background jobs per session; independent of `statuses` (a 'done' session can have some). */
  background: ReadonlyMap<string, SessionBackgroundJobs>;
  /** True once the first snapshot has been folded in, so `statuses` is a baseline rather than a gap. */
  loaded: boolean;
}

/** `useSessionStatuses` plus whether the initial snapshot has arrived; see that hook for the model. */
export function useSessionStatusFeed(): SessionStatusFeed {
  const [feed, setFeed] = useState<SessionStatusFeed>(() => ({
    statuses: new Map(),
    unreadReplies: new Set(),
    preparing: new Map(),
    background: new Map(),
    loaded: false,
  }));

  useEffect(() => {
    let live = true;
    // Sessions a push has already spoken for. Subscribing BEFORE reading the snapshot is what
    // stops a change landing in the gap being lost, but it also means the snapshot can resolve
    // already stale for a session - so it is applied only to sessions no push has covered.
    const pushed = new Set<string>();

    const unsubscribe = hostClient.onNotification('session/statusChanged', ({ event }, hostId) => {
      if (hostId !== LOCAL_HOST_ID) return;
      pushed.add(event.sessionId);
      setFeed(current => {
        const statuses = applyStatusEvents(current.statuses, [event]);
        const preparing = applyPreparingEvents(current.preparing, [event]);
        const unreadReplies = applyUnreadReplyEvents(current.unreadReplies, [event]);
        const background = applyBackgroundEvents(current.background, [event]);
        // Same object for a no-op push, so React skips re-rendering everything that reads the feed.
        if (
          statuses === current.statuses &&
          preparing === current.preparing &&
          unreadReplies === current.unreadReplies &&
          background === current.background
        )
          return current;
        return { ...current, statuses, preparing, unreadReplies, background };
      });
    });

    void hostClient.request(LOCAL_HOST_ID, 'session/statuses').then(({ statuses: snapshot }) => {
      if (!live) return;
      const unspoken = snapshot.filter(entry => !pushed.has(entry.sessionId));
      setFeed(current => ({
        loaded: true,
        statuses: applyStatusEvents(current.statuses, unspoken),
        unreadReplies: applyUnreadReplyEvents(current.unreadReplies, unspoken),
        preparing: applyPreparingEvents(current.preparing, unspoken),
        background: applyBackgroundEvents(current.background, unspoken),
      }));
    });

    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return feed;
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

/** The least time between catalog reloads that window focus may start. */
export const FOCUS_RELOAD_MIN_MS = 30_000;

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
 *
 * Window focus also reloads it (at most once per `FOCUS_RELOAD_MIN_MS`), since a model pulled
 * outside Desktop raises no event.
 */
export function useModelCatalog(local = false): ModelCatalogController {
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runtime, setRuntime] = useState<ModelRuntimeStatus | null>(null);
  const latestLoad = useRef(0);
  const forcedLoad = useRef<Promise<void> | null>(null);
  const lastLoadAt = useRef(0);
  const seen = useRef({ empty: true, reachable: null as boolean | null });
  seen.current = { empty: models.length === 0, reachable: runtime?.reachable ?? null };

  const run = useCallback(
    async (force: boolean | 'local', quiet: boolean) => {
      const mine = ++latestLoad.current;
      lastLoadAt.current = Date.now();
      if (!quiet) setLoading(true);
      try {
        const [catalog, status] = await Promise.all([
          hostChat.listModels(force),
          local ? window.b4m.models.getStatus().catch(() => null) : null,
        ]);
        // A slower, older response must not overwrite a newer one.
        if (mine !== latestLoad.current) return;
        setModels(catalog.models);
        setError(catalog.error ?? null);
        setRuntime(status);
        setLoading(false);
      } catch (err) {
        if (mine !== latestLoad.current) return;
        setError(err instanceof Error ? err.message : 'Could not load the model list.');
        setLoading(false);
      }
    },
    [local]
  );

  const load = useCallback(
    (force: boolean | 'local', quiet = false): Promise<void> => {
      const promise = run(force, quiet);
      if (!force) return promise;
      forcedLoad.current = promise;
      void promise.then(() => {
        if (forcedLoad.current === promise) forcedLoad.current = null;
      });
      return promise;
    },
    [run]
  );

  // Models pulled outside Desktop (the CLI, Ollama itself) raise no event; coming back to the window is the cue.
  useEffect(() => {
    const check = async () => {
      if (document.hidden) return;
      const status = await window.b4m.models.getStatus().catch(() => null);
      if (!status) return;
      const { empty, reachable } = seen.current;
      if (status.reachable !== reachable || (status.reachable && empty)) await load('local', true);
    };
    const onReturn = () => {
      if (document.hidden) return;
      if (Date.now() - lastLoadAt.current >= FOCUS_RELOAD_MIN_MS) void load('local', true);
      else if (local) void check();
    };
    const timer = local ? setInterval(() => void check(), LOCAL_STATUS_POLL_MS) : undefined;
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
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
  // Main already dropped its device-side cache or rebuilt the hosted one with late effort levels, so an unforced
  // read picks up the change and keeps the hosted half.
  useEffect(() => window.b4m.chat.onModelsChanged(() => void load(false, true)), [load]);

  const reload = useCallback(() => forcedLoad.current ?? load(true), [load]);

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
  /** The chat whose read failed, so the shell stops treating it as opening; null otherwise. */
  openFailedFor: string | null;
  /** One-shot message about something main changed while accepting a turn. Not a failure. */
  notice: string | null;
  dismissNotice: () => void;
  /** False when main refused the turn; the text is already back in the composer. */
  /** `notes` reach the model with this turn and are never drawn; see SendMessageRequest.notes. */
  send: (text: string, attachments?: readonly ChatAttachment[], notes?: readonly string[]) => Promise<boolean>;
  /** Device-local: move a conversation whose model is not installed to the one a send would use. */
  settleLocalModel: () => Promise<void>;
  stop: () => void;
  /** Resume the last reply if the agent loop's budget cut it short. */
  continueReply: () => Promise<void>;
  /**
   * Replace a sent prompt with `text`, dropping every turn after it, and send it. False when main
   * refused; the thread is put back and the reason is in `sendError`.
   */
  editMessage: (messageId: string, text: string) => Promise<boolean>;
  /** Drop the last reply and run its prompt again. A refusal puts the reply back. */
  regenerate: () => Promise<void>;
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
  /** How long the server keeps this conversation's prompt cache. Sent only on a model that takes the hour. */
  setPromptCacheTtl: (ttl: PromptCacheTtl) => Promise<void>;
  /**
   * Replace this conversation's sampling and output overrides; `{}` returns every one to the model
   * default. False, with a notice, when they were not saved.
   */
  setGeneration: (generation: GenerationSettings) => Promise<boolean>;
  /**
   * Set how much this conversation may do without asking. Driven by the composer pill, from a
   * click, and from nothing else: this is the only path to the mode in the renderer.
   */
  setApprovalMode: (mode: ChatApprovalMode) => Promise<void>;
  /** Turn Orchestrate on or off for this conversation; see ChatSessionMeta.orchestrate. */
  setOrchestrate: (orchestrate: boolean, budgetCredits?: number) => Promise<void>;
  /** Where this Code session is grounded, for the chip row. Inert on a Chat session. */
  project: ProjectBindingController;
  /**
   * Share `path`, or what main's picker returns, into the chat `target`, open or not. Once `target` is not open, a
   * refusal throws and a warning is returned rather than shown; an IPC failure always throws.
   */
  addContextDirectoryTo: (target: string, path?: string) => Promise<string | undefined>;
  /** Answer a tool call waiting at the approval gate. Nothing has run until this is called. */
  respondToApproval: (approvalId: string, answer: ChatApprovalAnswer) => void;
}

/** A session read in flight, and whether main wrote a summary for that session while it was. */
interface SessionRead {
  sessionId: string;
  stale: boolean;
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
  onSummaryChanged: (summary: ChatSessionSummary) => void,
  onShared?: (sessionId: string) => void
): ConversationController {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [turn, setTurn] = useState<TurnProgress | null>(null);
  const [phase, setPhase] = useState<ModelPhase | null>(null);
  const [preparing, setPreparing] = useState<WorkspaceProgress | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [openFailedFor, setOpenFailedFor] = useState<string | null>(null);
  const [notices, setNotices] = useState<ContextNotice[]>([]);
  const notice = useMemo(() => noticeText(notices), [notices]);
  const setNotice = useCallback((text: string | null) => setNotices(text ? [{ message: text }] : []), []);
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectError, setProjectError] = useState<ProjectBindingError | null>(null);
  const [queued, setQueued] = useState<ChatQueuedMessage[]>([]);
  const [returned, setReturned] = useState<{ id: number; messages: ChatQueuedMessage[] } | null>(null);
  const settledTurns = useSettledTurns();
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

  // A reconnect may have missed a held notice being set or withdrawn, and notices are not replayed
  // with the session's events, so the open session's are read again.
  useHostResync(hostId => {
    const id = activeSessionId.current;
    if (!id || hostId !== hostForSession(id)) return;
    void hostChat
      .readSession(id)
      .then(({ notices: held }) => {
        if (activeSessionId.current === id) setNotices(list => withHeldNotices(list, held));
      })
      .catch((error: unknown) => console.warn(`Could not re-read the notices of ${id}`, error));
  });

  // Every session's notices, the open one's included: the one path they reach the window by.
  useEffect(
    () =>
      hostClient.onNotification('session/contextNotice', ({ event }, hostId) => {
        if (hostId !== hostForSession(event.sessionId)) return;
        const apply = (list: ContextNotice[] | undefined): ContextNotice[] =>
          event.type === 'context-notice'
            ? addNotice(list, { message: event.message, kind: event.kind })
            : (list ?? []).filter(item => item.kind !== event.kind);
        if (event.sessionId === activeSessionId.current) setNotices(current => apply(current));
        else backgroundNotices.set(event.sessionId, apply(backgroundNotices.get(event.sessionId)));
      }),
    []
  );
  activeSessionId.current = sessionId;
  const onSharedRef = useRef(onShared);
  onSharedRef.current = onShared;

  // The open chat's read in flight, done again if main writes that chat a summary meanwhile, as it may predate it.
  const openRead = useRef<SessionRead | null>(null);
  // Holds the open chat's stream while its read is in flight; see StreamResumeGate.
  const streamGate = useRef(new StreamResumeGate());
  // The subscription's handler, so the session load can apply what the gate held. Set before any read can land.
  const applyStreamEvent = useRef<(event: ChatStreamEvent, reflected?: boolean) => void>(() => {});
  // What the open chat's subscription hands each event to; set by the effect that owns the live-reply state.
  const receiveStreamEvent = useRef<(event: ChatStreamEvent) => void>(() => {});
  // The chat the reset below last ran for. A share result that lands before then would be wiped by it.
  const resetFor = useRef<string | null>(null);

  /** Replies this window has seen end; see the session load, which must not reopen one. */
  const settledReplies = useRef(new Set<string>());

  /** The session this window has a send out for, read by the subscription; see applyWorkspaceEvent. */
  const sendingFor = useRef<string | null>(null);
  // An imported refresh must not replace a prompt, boundary or reply that arrived after its read began.
  const transcriptVersion = useRef(0);
  const workspaceVersion = useRef(0);
  const historyVersion = useRef(0);
  // Each params save replaces the whole set, so only a chat's latest answer may land.
  const generationVersions = useRef(new Map<string, number>());

  useEffect(() => {
    setSendError(null);
    setOpenFailedFor(null);
    setNotices(backgroundNotices.get(sessionId ?? '') ?? []);
    if (sessionId) backgroundNotices.delete(sessionId);
    setProjectError(null);
    const stashed = sessionId ? backgroundReturned.get(sessionId) : undefined;
    if (sessionId) backgroundReturned.delete(sessionId);
    setReturned(stashed ? { id: ++returnBatch.current, messages: stashed } : null);
    setQueued([]);
    setCommandProgress(null);
    setPreparing(null);
    setPhase(null);
    resetFor.current = sessionId;
    if (!sessionId) {
      setSession(null);
      setMessages([]);
      setStreaming(false);
      setTurn(null);
      return;
    }

    let current = true;
    let settledRereads = 0;
    const applyHeld = (events: readonly ChatStreamEvent[], reflected = false): void => {
      for (const event of events) applyStreamEvent.current(event, reflected);
    };
    const load = (): void => {
      const read: SessionRead = { sessionId, stale: false };
      openRead.current = read;
      streamGate.current.hold(sessionId);
      const preparationBeforeRead = workspaceVersion.current;
      const historyBeforeRead = historyVersion.current;
      const failed = (error: unknown): void => {
        if (!current) return;
        // No snapshot to cut against, so what arrived meanwhile applies as it would have unheld;
        // ahead of the checks below, which may need the version bumps it makes.
        applyHeld(streamGate.current.release());
        if (preparationBeforeRead !== workspaceVersion.current) return load();
        if (historyBeforeRead !== historyVersion.current) return load();
        if (read.stale) return load();
        if (openRead.current === read) openRead.current = null;
        const reason = error instanceof Error ? error.message : String(error);
        const detail = reason.replace(/^Error invoking remote method '[^']*': (?:Error(?:: |$))?/, '');
        setSendError(`Could not open this conversation. ${detail}`);
        setSession(null);
        setMessages([]);
        setStreaming(false);
        setTurn(null);
        setOpenFailedFor(sessionId);
      };
      void hostChat
        .readSession(sessionId)
        .then(({ session: loaded, notices: held }) => {
          if (!current) return;
          if (preparationBeforeRead !== workspaceVersion.current) return load();
          if (historyBeforeRead !== historyVersion.current) return load();
          if (read.stale) return load();
          // A reply already running arrives as main's live copy, and the events from now on
          // extend it. One that settled while this read was in flight is stale: read again
          // rather than put back a turn the 'done' already closed.
          const live = loaded?.replyInFlight;
          // Bounded so an id wrongly left settled shows the live copy instead of blanking the thread in a read loop.
          if (live && settledReplies.current.has(live.messageId) && settledRereads < MAX_SETTLED_REREADS) {
            settledRereads++;
            return load();
          }
          if (openRead.current === read) openRead.current = null;
          setSession(loaded);
          // The read is the only way back to a held notice this window missed, as after a reconnect.
          setNotices(list => withHeldNotices(list, held));
          setMessages(loaded?.messages ?? []);
          const { unseen, reflected } = loaded
            ? streamGate.current.resolve(loaded.eventCursor)
            : { unseen: streamGate.current.release(), reflected: [] };
          // A started session opened while its worktree is still being cut: no event is coming
          // to say so, the 'workspace' one went out before this window was looking.
          setPreparing(current => current ?? loaded?.preparingWorkspace ?? null);
          setStreaming(!!live);
          setTurn(
            live ? { startedAt: live.startedAt, tokens: null, messageId: live.messageId, requestAt: null } : null
          );
          // After the snapshot's own state, so each lands on top of the read it postdates. The
          // snapshot holds a reflected event's transcript and turn but not its side effects.
          applyHeld(reflected, true);
          applyHeld(unseen);
        })
        .catch(failed);
    };
    // Read rather than derived: main owns the queue, and a window opening onto a session that
    // was queued into from another one has witnessed no push for it.
    const readQueue = (): void => {
      void hostChat.getQueuedMessages(sessionId).then(pending => {
        if (current) setQueued(pending);
      });
    };
    // Subscribed before the read, so the read's cursor is at or past the subscription's and the
    // gate can cut between them. A resync means events were lost: the snapshot is read again.
    const release = sessionEvents.subscribe(
      { hostId: hostForSession(sessionId), sessionId },
      {
        event: event => receiveStreamEvent.current(event),
        resync: () => {
          if (!current) return;
          load();
          readQueue();
        },
      }
    );
    load();
    readQueue();
    return () => {
      current = false;
      release();
      // Applied rather than dropped: as events of a chat no longer open they still count settled
      // turns and keep background notices, as they would have unheld.
      applyHeld(streamGate.current.release());
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
        const loaded = await hostChat.getSession(sessionId);
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
    return hostClient.onNotification('session/summaryChanged', ({ summary }, hostId) => {
      if (hostId !== LOCAL_HOST_ID || summary.id !== activeSessionId.current) return;
      historyVersion.current++;
      // The project too: a worktree landing under an open session is pushed this way, and the
      // chips have to stop saying it is on its way.
      setSession(current =>
        current
          ? {
              ...current,
              title: summary.title,
              project: summary.project,
              historyEnabled: summary.historyEnabled,
              model: summary.model,
              orchestrationPolicy: summary.orchestrationPolicy,
              workerSelection: summary.workerSelection,
              workerTask: summary.workerTask,
            }
          : current
      );
    });
  }, []);

  useEffect(() => {
    return hostClient.onNotification('session/queueChanged', ({ event }, hostId) => {
      const open = activeSessionId.current;
      if (!open || hostId !== hostForSession(open) || event.sessionId !== open) return;
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
      // An event queued just before the open chat's read began can be one its snapshot already
      // holds; that snapshot may have landed while the event waited for this frame.
      const pending = queued.filter(event => !streamGate.current.reflects(event));
      queued = [];
      if (pending.length === 0) return;
      const events = coalesceLiveEvents(pending);
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

    const apply = (event: ChatStreamEvent, reflected = false): void => {
      const live =
        event.type === 'delta' ||
        event.type === 'tool-start' ||
        event.type === 'tool-end' ||
        event.type === 'tool-progress';
      if (live) {
        if (reflected || event.sessionId !== activeSessionId.current) return;
        // A folder the user just added has to show up in the chips at once - that row is where it
        // is revoked - and main pushes no summary for it.
        if (
          event.type === 'tool-end' &&
          event.call.name === REQUEST_DIRECTORY_TOOL_NAME &&
          parseDirectoryOutcome(event.call.input.outcome)?.status === 'granted'
        ) {
          const granted = event.sessionId;
          void hostChat.getSession(granted).then(loaded => {
            if (!loaded || activeSessionId.current !== granted) return;
            onSharedRef.current?.(granted);
            setSession(current =>
              current?.id === granted
                ? { ...current, project: loaded.project, grantedDirectories: loaded.grantedDirectories }
                : current
            );
          });
        }
        // The call has arrived, so the tool's own status takes over; the next round sends a phase anew.
        if (event.type === 'tool-start') {
          setPhase(null);
          const at = Date.now();
          setTurn(current => (current ? withPhase(current, { kind: 'waiting' }, at) : current));
        }
        queued.push(event);
        frame ??= requestAnimationFrame(flushLive);
        // rAF is paused in a hidden or occluded window; without this the reply stalls until the
        // next non-live event or until the window is shown again.
        fallback ??= setTimeout(flushLive, LIVE_FLUSH_FALLBACK_MS);
        return;
      }
      // Anything that is not a live event may depend on, or replace, what is still queued.
      flushLive();

      // A resumed reply keeps its id, so its run is live again and must not read as settled.
      if (event.type === 'start') settledReplies.current.delete(event.messageId);
      if (event.type === 'done' || event.type === 'error') settledReplies.current.add(event.messageId);
      // Notices arrive only through session/contextNotice (the effect above), for the open
      // session too; the copy a host still sends here for 1.2 clients is ignored, so a notice is
      // never applied twice. That assumes the bundled host: gate on the negotiated minor before
      // this window can talk to a 1.2 host.
      if (event.type === 'context-notice' || event.type === 'context-notice-cleared') return;
      if (event.sessionId !== activeSessionId.current) return;

      if (event.type === 'phase') {
        setPhase(event.phase);
        // A sign of life like any other frame: a thinking marker carries no text to stamp it.
        const at = Date.now();
        setTurn(current => (current ? { ...withPhase(current, event.phase, at), lastEventAt: at } : current));
        return;
      }

      // A reflected event's transcript and turn are already in the snapshot; only what the
      // snapshot cannot carry (notices, a compaction's progress) still runs.
      if (reflected) {
        if (event.type === 'start' || event.type === 'done' || event.type === 'error') setPhase(null);
        if (event.type !== 'auto-compact' && event.type !== 'context-trimmed') return;
      }

      if (event.type === 'start') {
        workspaceVersion.current++;
        setPhase(null);
        setPreparing(null);
        setStreaming(true);
        reasoning = '';
        const startedAt = Date.now();
        setTurn({
          startedAt,
          tokens: null,
          lastEventAt: startedAt,
          messageId: event.messageId,
          ...(event.baseUsage ? { continued: true } : {}),
        });
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
            ...(event.stats ? { stats: event.stats } : {}),
          };
        });
      });
    };
    applyStreamEvent.current = apply;

    receiveStreamEvent.current = event => {
      // Counted on arrival, held or not: an imported refresh must not land over it either way.
      if (event.sessionId === activeSessionId.current) transcriptVersion.current++;
      const admission = streamGate.current.admit(event);
      if (admission === 'hold') return;
      apply(event, admission === 'reflected');
    };

    return () => {
      receiveStreamEvent.current = () => {};
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (fallback !== undefined) clearTimeout(fallback);
    };
  }, []);

  const sessionProject = session?.project;
  const send = useCallback(
    async (
      text: string,
      attachments: readonly ChatAttachment[] = [],
      notes: readonly string[] = []
    ): Promise<boolean> => {
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
            ...(notes.length > 0 ? { notes: [...notes] } : {}),
          }
        : null;
      if (optimistic) setMessages(current => [...current, optimistic]);

      const discardOptimistic = () => {
        if (optimistic) setMessages(current => current.filter(message => message.id !== optimistic.id));
      };

      if (goingOut) sendingFor.current = sessionId;
      const result = await hostChat
        .sendMessage({
          sessionId,
          text: prompt,
          ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
          ...(notes.length > 0 ? { notes: [...notes] } : {}),
        })
        .finally(() => {
          if (!goingOut) return;
          if (sendingFor.current === sessionId) sendingFor.current = null;
          // Whatever the outcome: a refused turn has no 'start' coming to clear it.
          if (activeSessionId.current === sessionId) setPreparing(null);
        });
      if (activeSessionId.current !== sessionId) {
        if (!result.ok && prompt) {
          backgroundReturned.set(sessionId, [
            ...(backgroundReturned.get(sessionId) ?? []),
            { id: 'refused', sessionId, text: prompt, queuedAt: new Date().toISOString() },
          ]);
        }
        return result.ok;
      }
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

      const summary = await hostChat.getSession(sessionId);
      if (summary) {
        // A late read for the chat we left must not put the selected thread back behind its opening gate.
        if (activeSessionId.current === sessionId) {
          setSession(current => (current?.id === sessionId ? summary : current));
        }
        onSummaryChanged(summarizeSession(summary));
      }
      return true;
    },
    [sessionId, streaming, preparing, sessionProject, onSummaryChanged]
  );

  const stop = useCallback(() => {
    if (sessionId) void hostChat.stopReply(sessionId);
  }, [sessionId]);

  // No optimistic update: the reply's own 'start' event clears the stop-reason chip, and doing
  // it here as well would hide the button on a continue main went on to refuse.
  const continueReply = useCallback(async () => {
    if (!sessionId) return;
    setSendError(null);
    const result = await window.b4m.chat.continueReply(sessionId);
    if (!result.ok) setSendError(result.error);
  }, [sessionId]);

  // Main just wrote this chat, so a read of it still in flight may predate the write and is done again.
  const outdateOpenRead = useCallback((id: string) => {
    const read = openRead.current;
    if (read && read.sessionId === id) read.stale = true;
  }, []);

  /**
   * Both rewinds draw at once - the dropped turns leave the thread before the round trip, as a
   * send's prompt appears before it - and put the thread back if main refuses. Main truncates
   * the stored thread itself (SessionStore.truncateFrom), so a reload shows the same history.
   */
  const rewind = useCallback(
    async (
      next: (current: ChatMessage[]) => ChatMessage[],
      call: (id: string) => Promise<SendMessageResult>
    ): Promise<boolean> => {
      if (!sessionId) return false;
      transcriptVersion.current++;
      outdateOpenRead(sessionId);
      setSendError(null);
      setNotice(null);
      const before = messages;
      setMessages(next(before));
      const result = await call(sessionId);
      if (activeSessionId.current !== sessionId) return result.ok;
      if (!result.ok) {
        setMessages(before);
        setSendError(result.error);
        return false;
      }
      if (!result.queued && result.notice) setNotice(result.notice);
      const updated = await hostChat.getSession(sessionId);
      if (updated) {
        if (activeSessionId.current === sessionId)
          setSession(current => (current?.id === sessionId ? updated : current));
        onSummaryChanged(summarizeSession(updated));
      }
      return true;
    },
    [sessionId, messages, onSummaryChanged, outdateOpenRead]
  );

  const editMessage = useCallback(
    async (messageId: string, text: string): Promise<boolean> => {
      const prompt = text.trim();
      if (!prompt) return false;
      return rewind(
        current => {
          const at = current.findIndex(message => message.id === messageId);
          if (at < 0) return current;
          const { attachments } = current[at];
          const notes = carriedNotes(current[at]);
          return [
            ...current.slice(0, at),
            {
              id: `${OPTIMISTIC_ID_PREFIX}${Date.now()}`,
              role: 'user',
              content: prompt,
              createdAt: new Date().toISOString(),
              ...(attachments?.length ? { attachments } : {}),
              ...(notes.length ? { notes } : {}),
            },
          ];
        },
        id => window.b4m.chat.editMessage({ sessionId: id, messageId, text: prompt })
      );
    },
    [rewind]
  );

  const regenerate = useCallback(async () => {
    await rewind(
      current => (regenerableReply(current) ? current.slice(0, -1) : current),
      id => window.b4m.chat.regenerateReply(id)
    );
  }, [rewind]);

  // A summary main just wrote, folded into both the open conversation and the sidebar row. The
  // open conversation only when it is that session: a share can return after the user moved on.
  const applySummary = useCallback(
    (updated: ChatSessionSummary) => {
      outdateOpenRead(updated.id);
      setSession(current =>
        current?.id === updated.id
          ? { ...current, project: updated.project, grantedDirectories: updated.grantedDirectories }
          : current
      );
      onSummaryChanged(updated);
    },
    [onSummaryChanged, outdateOpenRead]
  );

  // One main-side share for the chip's picker (no `path`), /add-dir and Add folder; `confirm` echoes a typed addition.
  // Results show only while `target` is open; with `keep`, a refusal elsewhere throws and a warning is returned.
  const shareDirectory = useCallback(
    async (path: string | undefined, confirm: boolean, target = sessionId, keep = false) => {
      if (!target) return;
      const result = await window.b4m.chat.addContextDirectory(target, path);
      if (result.status === 'cancelled') return;
      const stillOpen = activeSessionId.current === target && resetFor.current === target;
      if (result.status === 'refused') {
        if (stillOpen) setSendError(result.error);
        else if (keep) throw new Error(result.error);
        return;
      }
      if (result.status === 'already') {
        if (stillOpen) setNotice(`${result.path} is already shared with this conversation.`);
        return;
      }
      applySummary(result.session);
      onSharedRef.current?.(target);
      if (!confirm && !result.warning) return;
      const said = [`Shared ${result.path} with this conversation.`, result.warning].filter(Boolean).join(' ');
      if (stillOpen) setNotice(said);
      else if (keep) return said;
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
      if (name === 'loop') {
        const result = await window.b4m.chat.loopCommand(sessionId, args);
        if (activeSessionId.current !== sessionId) return;
        if (!result.ok) setSendError(result.error);
        else
          setNotice(
            result.notice ??
              (result.state
                ? args.trim() === 'list'
                  ? `Loop ${result.state.phase}: ${result.state.prompt}`
                  : null
                : 'No active loop in this session.')
          );
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
        if (activeSessionId.current !== sessionId) return;
        if (!result.ok) {
          setSendError(result.error);
          return;
        }
        outdateOpenRead(sessionId);
        setSession(result.session);
        setMessages(result.session.messages);
      } finally {
        if (activeSessionId.current === sessionId) setCommandProgress(null);
      }
    },
    [sessionId, shareDirectory, outdateOpenRead]
  );

  const cancelQueued = useCallback(
    (queuedId: string) => {
      if (sessionId) void hostChat.cancelQueuedMessage(sessionId, queuedId);
    },
    [sessionId]
  );

  // No optimistic update: main owns the queue and pushes the result, and the turn may well
  // have finished on its own by the time this lands, which makes it a no-op there.
  const sendQueuedNow = useCallback(
    (queuedId: string) => {
      if (sessionId) void hostChat.sendQueuedMessageNow(sessionId, queuedId);
    },
    [sessionId]
  );

  const clearReturned = useCallback(() => setReturned(null), []);

  // A save resolves after the user may have moved to another chat: the list always takes the
  // result, the open chat only when it is still the one that was saved.
  const saveSetting = useCallback(
    async (
      what: string,
      save: (id: string) => Promise<ChatSessionSummary | null>,
      apply: (updated: ChatSessionSummary) => Partial<ChatSession>,
      clearsNotice = false
    ) => {
      if (!sessionId) return;
      try {
        const updated = await save(sessionId);
        if (!updated) return;
        outdateOpenRead(sessionId);
        if (clearsNotice && activeSessionId.current === sessionId) setNotice(null);
        setSession(current => (current?.id === sessionId ? { ...current, ...apply(updated) } : current));
        onSummaryChanged(updated);
      } catch (error) {
        if (activeSessionId.current === sessionId) {
          setNotice(`Could not save ${what}. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    [sessionId, onSummaryChanged, outdateOpenRead]
  );

  const rename = useCallback(
    (title: string) =>
      saveSetting(
        'the title',
        id => hostChat.renameSession(id, title),
        updated => ({ title: updated.title })
      ),
    [sessionId, saveSetting]
  );

  const setModel = useCallback(
    (model: string) =>
      saveSetting(
        'the model',
        id => window.b4m.chat.setSessionModel(id, model),
        updated => ({ model: updated.model }),
        true
      ),
    [sessionId, saveSetting]
  );

  const settleLocalModel = useCallback(async () => {
    if (!sessionId) return;
    let settled: Awaited<ReturnType<typeof window.b4m.chat.settleLocalModel>>;
    try {
      settled = await window.b4m.chat.settleLocalModel(sessionId);
    } catch (error) {
      if (activeSessionId.current === sessionId) {
        setNotice(`Could not settle the local model. ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (!settled) return;
    outdateOpenRead(sessionId);
    if (activeSessionId.current !== sessionId) return;
    if (settled.notice) setNotice(settled.notice);
    setSession(current => (current?.id === sessionId ? { ...current, model: settled.session.model } : current));
    onSummaryChanged(settled.session);
  }, [sessionId, onSummaryChanged, outdateOpenRead]);

  const setHistory = useCallback(
    async (enabled: boolean) => {
      if (!sessionId || session?.id !== sessionId) return;
      const version = historyVersion.current;
      try {
        const updated = await window.b4m.chat.setSessionHistory(sessionId, enabled);
        if (!updated) return;
        outdateOpenRead(sessionId);
        if (version !== historyVersion.current) return;
        setSession(current =>
          current?.id === sessionId ? { ...current, historyEnabled: updated.historyEnabled } : current
        );
        onSummaryChanged(updated);
      } catch (error) {
        if (activeSessionId.current === sessionId) {
          setNotice(`Could not update local history. ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    },
    [sessionId, session?.id, onSummaryChanged, outdateOpenRead]
  );

  const setReasoningEffort = useCallback(
    (effort: ReasoningEffortSetting) =>
      saveSetting(
        'the reasoning effort',
        id => window.b4m.chat.setSessionReasoningEffort(id, effort),
        updated => ({ reasoningEffort: updated.reasoningEffort })
      ),
    [sessionId, saveSetting]
  );

  const setPromptCacheTtl = useCallback(
    (ttl: PromptCacheTtl) =>
      saveSetting(
        'the prompt cache setting',
        id => window.b4m.chat.setSessionPromptCacheTtl(id, ttl),
        updated => ({ promptCacheTtl: updated.promptCacheTtl })
      ),
    [sessionId, saveSetting]
  );

  const setGeneration = useCallback(
    async (generation: GenerationSettings): Promise<boolean> => {
      if (!sessionId || session?.id !== sessionId) return false;
      const versions = generationVersions.current;
      const version = (versions.get(sessionId) ?? 0) + 1;
      versions.set(sessionId, version);
      const latest = () => versions.get(sessionId) === version;
      try {
        const updated = await window.b4m.chat.setSessionGeneration(sessionId, generation);
        if (!updated) throw new Error('The conversation could not be found.');
        outdateOpenRead(sessionId);
        if (!latest()) return true;
        setSession(current => (current?.id === sessionId ? { ...current, generation: updated.generation } : current));
        onSummaryChanged(updated);
        return true;
      } catch (error) {
        if (!latest()) return false;
        if (activeSessionId.current === sessionId) {
          setNotice(`Could not save this chat's params. ${error instanceof Error ? error.message : String(error)}`);
        }
        // An older save skipped as stale may still have landed, so show what main holds now.
        const stored = await hostChat.getSession(sessionId).catch(() => null);
        if (stored && latest()) {
          setSession(current => (current?.id === sessionId ? { ...current, generation: stored.generation } : current));
        }
        return false;
      }
    },
    [sessionId, session?.id, onSummaryChanged, outdateOpenRead]
  );

  const setApprovalMode = useCallback(
    (mode: ChatApprovalMode) =>
      saveSetting(
        'the approval mode',
        id => window.b4m.chat.setApprovalMode(id, mode),
        updated => ({ approvalMode: updated.approvalMode })
      ),
    [sessionId, saveSetting]
  );

  const setOrchestrate = useCallback(
    async (orchestrate: boolean, budgetCredits?: number) => {
      if (!sessionId) return;
      const request =
        budgetCredits === undefined
          ? window.b4m.chat.setSessionOrchestrate(sessionId, orchestrate)
          : window.b4m.chat.setSessionOrchestrate(sessionId, orchestrate, budgetCredits);
      const updated = await request.catch((error: unknown) => {
        if (activeSessionId.current === sessionId) {
          setNotice(`Could not change Orchestrate. ${error instanceof Error ? error.message : String(error)}`);
        }
        return null;
      });
      if (!updated) return;
      outdateOpenRead(sessionId);
      // The reply can land after a switch to another conversation, which must keep its own flag.
      setSession(current => {
        if (current?.id !== sessionId) return current;
        const { orchestrate: _previous, orchestrationPolicy: _policy, ...rest } = current;
        return {
          ...rest,
          ...(updated.orchestrate ? { orchestrate: true } : {}),
          ...(updated.orchestrationPolicy ? { orchestrationPolicy: updated.orchestrationPolicy } : {}),
        };
      });
      onSummaryChanged(updated);
    },
    [sessionId, onSummaryChanged, outdateOpenRead]
  );

  const respondToApproval = useCallback(
    (approvalId: string, answer: ChatApprovalAnswer) => {
      if (!sessionId) {
        console.warn('Dropped an approval answer because no session is open');
        return;
      }
      hostChat
        .respondToApproval(sessionId, approvalId, answer)
        .catch(cause => console.warn('Could not answer the approval', cause));
    },
    [sessionId]
  );

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
      const inspected = await hostChat.inspectProject(directory);
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

  // As addContextDirectory, for a chat named by id: it clears the open chat's messages only when that is the chat.
  const addContextDirectoryTo = useCallback(
    async (target: string, path?: string) => {
      if (activeSessionId.current === target) {
        setProjectError(null);
        setSendError(null);
        setNotice(null);
      }
      return await shareDirectory(path, false, target, true);
    },
    [shareDirectory]
  );

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
    openFailedFor,
    notice,
    dismissNotice,
    send,
    stop,
    continueReply,
    editMessage,
    regenerate,
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
    setPromptCacheTtl,
    setGeneration,
    setApprovalMode,
    setOrchestrate,
    project,
    addContextDirectoryTo,
    respondToApproval,
  };
}
