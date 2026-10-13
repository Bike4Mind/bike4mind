import { create } from 'zustand';
import { Conversation } from '@elevenlabs/client';
import type { Mode } from '@elevenlabs/client';
import { api } from '@client/app/contexts/ApiContext';
import axios from 'axios';

export interface ConversationalClientBootstrap {
  transport: 'elevenlabs-conversational';
  signedUrl: string;
  agentId: string;
  /** Per-user TTS voice override applied via SDK `overrides.tts.voiceId`. */
  voiceOverrideId?: string;
  /** Per-user system prompt override applied via SDK `overrides.agent.prompt.prompt`. */
  systemPromptOverride?: string;
  /** Signed session token forwarded to ElevenLabs and verified by the proxy. */
  sessionToken: string;
}

interface SessionsResponse {
  session: { id: string; name: string };
  reasoningModelId: string;
  clientBootstrap: ConversationalClientBootstrap;
}

type Phase = 'idle' | 'requesting-session' | 'connecting' | 'connected' | 'reconnecting' | 'ended' | 'error';
type ConversationHandle = Awaited<ReturnType<typeof Conversation.startSession>>;

export interface StartVoiceOptions {
  /** Existing B4M session to attach the call to. Omit to create a new one. */
  sessionId?: string;
  /** Reasoning model override. Falls back to the server default. */
  reasoningModelId?: string;
  /**
   * Invoked once the session is resolved server-side, with the id and whether
   * it was newly created. The caller (a component inside the router) uses this
   * to navigate to the new session - navigation can't live in the store.
   */
  onSessionResolved?: (sessionId: string, isNew: boolean) => void;
}

interface ConversationalVoiceState {
  phase: Phase;
  errorMessage: string | null;
  /** Server-confirmed reasoning model for the active session. */
  reasoningModelId: string | null;
  /** Whether the agent is currently speaking or listening (standby). */
  mode: Mode | null;
  /** The most recent thing the user said (live STT), for status display. */
  lastUserMessage: string | null;
  start: (options: StartVoiceOptions) => Promise<void>;
  end: () => Promise<void>;
}

// Module-level (non-reactive) handles. Living outside React is the whole point:
// the call must survive route remounts (e.g. /new -> /notebooks/$id) so the
// toolbar button on the destination route controls the SAME call.
let conversation: ConversationHandle | null = null;
let activeSessionId: string | null = null;
// Bumped on every start() and end(). The in-flight startSession() and the SDK's
// async callbacks capture this at start; if it has since changed, their call was
// superseded (the user ended or restarted) and they must not mutate live state -
// this closes the end-during-connecting race that otherwise orphans an open,
// credit-burning WebSocket the UI can no longer reach.
let startGen = 0;

// Notebook the newest live start() targets (undefined sessionId = a fresh notebook), and whether its
// first bootstrap has succeeded. Cleared whenever that call ends: end(), a failed mic check, a failed
// bootstrap, a terminal transport failure and a terminal disconnect.
// A superseded bootstrap skips its own /end only when the newer call is on the same notebook, since
// /end is keyed by notebook.
let liveStart: { sessionId?: string; bootstrapped: boolean } | null = null;

// Notebooks whose superseded bootstrap left its hold for a newer same-notebook bootstrap still in
// flight: the server settles the prior hold only when that bootstrap succeeds. A success drops its
// entry; a failed first start or end() sends /end for every entry, since nothing else will.
const deferredSettles = new Set<string>();

function settleDeferredHolds(): void {
  const ids = [...deferredSettles];
  deferredSettles.clear();
  void queueSettle(...ids);
}

// /end settles whatever hold its notebook has open, so one landing after a restart's /sessions
// would settle the new call's hold. Every /end goes through this chain and start() waits for it
// before bootstrapping. allSettled keeps a failed /end from stalling later ones.
let pendingSettles: Promise<unknown> = Promise.resolve();

function queueSettle(...ids: (string | null)[]): Promise<unknown> {
  const toSettle = ids.filter((id): id is string => id !== null);
  if (toSettle.length > 0) {
    pendingSettles = pendingSettles.then(() => Promise.allSettled(toSettle.map(id => reconcileVoiceSession(id))));
  }
  return pendingSettles;
}

// Bounded auto-reconnect after an abnormal disconnect (network drop - common on
// mobile when Wi-Fi<->cellular handoff or a signal dip kills the WebSocket). We
// re-establish against the SAME B4M session id, so server-side conversation
// context (keyed by the b4m_session token) persists; only the in-flight transport
// turn is lost. A user-/agent-initiated disconnect is NOT retried.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000];
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function clearReconnectTimer(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

// Reconcile the up-front credit reservation down to the call's connected time (a call that never
// connected costs nothing). Called on every end after a successful bootstrap: hang-up, natural
// disconnect, and each terminal failure. Best-effort: a failure leaves the hold to the server's
// voiceHoldSweep (apps/workers/src/cron/voiceHoldSweep.ts), and it must never block teardown or
// surface an error to the user. Safe to call more than once (the endpoint is idempotent).
async function reconcileVoiceSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    await api.post(`/api/voice/v2/sessions/${sessionId}/end`, {});
  } catch {
    // ignore - reservation reconciliation is not user-blocking
  }
}

// Connected-time billing reads these reports: the first marks the call connected, each one
// advances its last activity, so a tab closed mid-call is billed up to its last beat. Best-effort -
// a lost beat only shortens the billed time.
const VOICE_HEARTBEAT_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// The session token names the hold this call bills against, so a beat never marks a newer one.
function reportVoiceActivity(sessionId: string, sessionToken: string): void {
  api.post(`/api/voice/v2/sessions/${sessionId}/activity`, { sessionToken }).catch(() => {});
}

function startHeartbeat(sessionId: string | null, sessionToken: string): void {
  stopHeartbeat();
  if (!sessionId) return;
  reportVoiceActivity(sessionId, sessionToken);
  heartbeatTimer = setInterval(() => reportVoiceActivity(sessionId, sessionToken), VOICE_HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// Probe the microphone BEFORE bootstrapping: the bootstrap reserves credits, and a browser with no
// (or a denied) mic would otherwise reserve them for a call that can never connect. The tracks are
// released at once; the SDK reopens the mic itself.
async function ensureMicrophone(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('Microphone access is unavailable in this browser context.'), {
      name: window.isSecureContext ? 'NotSupportedError' : 'SecurityError',
    });
  }
  // Where the Permissions API answers, skip the probe unless the user would be prompted: on
  // browsers that do not persist a grant (Safari/iOS) a probe plus the SDK's own open prompts twice.
  let state: PermissionState | undefined;
  try {
    state = (await navigator.permissions?.query({ name: 'microphone' as PermissionName }))?.state;
  } catch {
    // microphone is not a queryable permission in every browser - fall through to the probe
  }
  if (state === 'denied') {
    throw Object.assign(new Error('Microphone permission denied'), { name: 'NotAllowedError' });
  }
  if (state === 'granted') return;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => track.stop());
}

function formatSessionsError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { error?: string; detail?: string } | string | undefined;
    let detail: string;
    if (typeof data === 'string') {
      detail = data;
    } else if (data && typeof data === 'object') {
      detail = data.detail ? `${data.error ?? ''} — ${data.detail}` : (data.error ?? JSON.stringify(data));
    } else {
      detail = '(no body)';
    }
    return `Sessions endpoint returned ${status}: ${detail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function formatConnectError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError') {
    return 'Microphone access denied. Allow this site to use the microphone in your browser settings (lock icon next to the URL), then try again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone detected. Plug in / select an audio input device, then retry.';
  }
  if (name === 'NotReadableError') {
    return 'Microphone is busy (in use by another app). Close other audio apps and retry.';
  }
  if (name === 'SecurityError') {
    return 'Microphone access needs a secure (https) connection. Open the site over https and retry.';
  }
  if (name === 'NotSupportedError') {
    return 'This browser does not support microphone access. Try a current Chrome, Edge, Firefox or Safari.';
  }
  return `Failed to open voice connection: ${err instanceof Error ? err.message : String(err)}`;
}

type VoiceSet = (partial: Partial<ConversationalVoiceState>) => void;

// The bits of the original start() request needed to re-establish the transport
// on a reconnect. activeSessionId carries the resolved B4M session across attempts.
interface ConnectContext {
  sessionId?: string;
  reasoningModelId?: string;
  onSessionResolved?: StartVoiceOptions['onSessionResolved'];
}

// Schedule the next reconnect attempt with exponential backoff. Bails at fire
// time if a newer start()/end() has superseded this generation.
//
// This function is the *consumer* of one reconnect-budget unit: callers gate on
// `reconnectAttempts < MAX_RECONNECT_ATTEMPTS` (the boundary check) and then call
// here, which spends the unit by incrementing. So the increment lives here, not
// at the call sites - don't also increment at the guard or you'll halve the budget.
function scheduleReconnect(set: VoiceSet, myGen: number, ctx: ConnectContext): void {
  const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
  reconnectAttempts++;
  set({ phase: 'reconnecting' });
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (myGen !== startGen) return; // superseded by end() or a newer start()
    void establishConnection(set, myGen, ctx, true);
  }, delay);
}

// Bootstrap a fresh signed URL (single-use) for the carryover session and open
// the ElevenLabs WebSocket. Shared by the first connect and every reconnect, so
// the SDK callback wiring (incl. the abnormal-disconnect -> reconnect branch)
// lives in exactly one place.
async function establishConnection(
  set: VoiceSet,
  myGen: number,
  ctx: ConnectContext,
  isReconnect: boolean
): Promise<void> {
  // True once end() (or a newer start()) has superseded this attempt.
  const isStale = () => myGen !== startGen;

  // Reuse the resolved session id so a reconnect re-attaches to the SAME B4M
  // session (server-side context persists) and a first-attempt retry doesn't
  // create a second empty session.
  const carryoverSessionId = activeSessionId ?? ctx.sessionId;
  const isNewSession = !carryoverSessionId;

  let bootstrap: SessionsResponse;
  try {
    const res = await api.post<SessionsResponse>('/api/voice/v2/sessions', {
      sessionId: carryoverSessionId,
      reasoningModelId: ctx.reasoningModelId,
      // Tell the server to reuse the existing credit hold rather than reserving
      // (and charging) a second time for the same call.
      isReconnect,
    });
    bootstrap = res.data;
  } catch (err) {
    if (isStale()) return;
    if (isReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect(set, myGen, ctx);
      return;
    }
    // Reconnects exhausted: the original connect's hold is still open, so settle it. A failed first
    // bootstrap reserved nothing, and activeSessionId is still null then, but it also settled no
    // prior hold, so a superseded same-notebook bootstrap must now settle its own.
    const sid = activeSessionId;
    activeSessionId = null;
    liveStart = null;
    settleDeferredHolds();
    set({
      phase: 'error',
      errorMessage: `Failed to ${isReconnect ? 'reconnect' : 'create'} voice session: ${formatSessionsError(err)}`,
    });
    void queueSettle(sid);
    return;
  }

  // Any successful bootstrap settled the notebook's prior hold server-side.
  const resolvedId = bootstrap.session?.id ?? null;
  if (resolvedId) deferredSettles.delete(resolvedId);

  // Superseded during the /sessions request - don't open a connection we'd orphan. A first
  // bootstrap already reserved credits, and end() ran before the id was known, so settle it here.
  // A bootstrap that created its own notebook is always settled: no other call can know that id.
  // When a newer start() targets the same notebook, /end could settle that call's hold instead:
  // skip once its bootstrap has succeeded (that settled the prior hold, and the live call's own /end
  // covers the notebook), otherwise defer to the outcome of that bootstrap.
  if (isStale()) {
    const newerSameNotebook = liveStart !== null && resolvedId !== null && liveStart.sessionId === resolvedId;
    if (isReconnect || !resolvedId) return;
    if (isNewSession || !newerSameNotebook) {
      void queueSettle(resolvedId);
    } else if (!liveStart?.bootstrapped) {
      deferredSettles.add(resolvedId);
    }
    return;
  }

  activeSessionId = resolvedId;
  if (!isReconnect) {
    if (liveStart) liveStart.bootstrapped = true;
    settleDeferredHolds();
  }
  // Only the first connect drives the requesting->connecting->navigate flow; a
  // reconnect stays in the 'reconnecting' phase until onConnect flips it.
  if (!isReconnect) {
    set({ reasoningModelId: bootstrap.reasoningModelId, phase: 'connecting' });
    if (bootstrap.session?.id) {
      ctx.onSessionResolved?.(bootstrap.session.id, isNewSession);
    }
  }

  const { voiceOverrideId, systemPromptOverride } = bootstrap.clientBootstrap;
  const ttsOverride = voiceOverrideId ? { tts: { voiceId: voiceOverrideId } } : undefined;
  const agentOverride = systemPromptOverride ? { agent: { prompt: { prompt: systemPromptOverride } } } : undefined;
  const overrides = ttsOverride || agentOverride ? { ...ttsOverride, ...agentOverride } : undefined;

  try {
    const conv = await Conversation.startSession({
      signedUrl: bootstrap.clientBootstrap.signedUrl,
      customLlmExtraBody: { b4m_session: bootstrap.clientBootstrap.sessionToken },
      ...(overrides ? { overrides } : {}),
      // All callbacks bail when superseded so a torn-down session can't write
      // into the state (or null out the handle) of a newer one.
      onConnect: () => {
        if (isStale()) return;
        // A clean connect clears the reconnect budget so a *later* independent
        // drop gets its own full set of retries.
        reconnectAttempts = 0;
        clearReconnectTimer();
        startHeartbeat(activeSessionId, bootstrap.clientBootstrap.sessionToken);
        set({ phase: 'connected', errorMessage: null });
      },
      onDisconnect: details => {
        if (isStale()) return;
        conversation = null;
        stopHeartbeat();
        // Abnormal close (network drop - common on mobile) -> bounded auto-reconnect
        // on the SAME session. A user-/agent-initiated end is a real end: reconcile
        // the credit hold and stop.
        if (details.reason === 'error' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          scheduleReconnect(set, myGen, ctx);
          return;
        }
        const sid = activeSessionId;
        activeSessionId = null;
        liveStart = null;
        set({
          phase: 'ended',
          mode: null,
          ...(details.reason === 'error'
            ? { errorMessage: details.message || 'Voice connection lost. Tap to start again.' }
            : {}),
        });
        void queueSettle(sid);
      },
      onError: message => {
        if (isStale()) return;
        set({ errorMessage: message });
      },
      onModeChange: ({ mode: m }) => {
        if (isStale()) return;
        set({ mode: m });
      },
      onMessage: ({ message, source }) => {
        if (isStale()) return;
        if (source === 'user' && message) set({ lastUserMessage: message });
      },
    });
    // Superseded while startSession was in flight: tear down the handle it
    // would otherwise leave open and unreachable, rather than adopting it.
    if (isStale()) {
      await conv.endSession().catch(() => {});
      return;
    }
    conversation = conv;
  } catch (err) {
    if (isStale()) return;
    conversation = null;
    // Asymmetry by design: a *throw* here means the transport never established,
    // so on a first connect we surface the error immediately rather than silently
    // retrying a call the user just initiated. Only an already-running reconnect
    // re-enters the ladder. (Contrast onDisconnect(reason='error') above, which
    // fires *after* a session was established and so recovers a transient drop
    // regardless of isReconnect - that's recovering a live call, not a failed start.)
    if (isReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      scheduleReconnect(set, myGen, ctx);
      return;
    }
    // The bootstrap above reserved credits (or kept the original hold on a reconnect); settle it
    // now rather than leave the whole reservation to the sweep.
    const sid = activeSessionId;
    activeSessionId = null;
    liveStart = null;
    clearReconnectTimer();
    set({ phase: 'error', errorMessage: formatConnectError(err) });
    void queueSettle(sid);
  }
}

export const useConversationalVoiceStore = create<ConversationalVoiceState>(set => ({
  phase: 'idle',
  errorMessage: null,
  reasoningModelId: null,
  mode: null,
  lastUserMessage: null,

  start: async ({ sessionId, reasoningModelId, onSessionResolved }) => {
    if (conversation) return;
    clearReconnectTimer();
    reconnectAttempts = 0;
    const myGen = ++startGen;
    liveStart = { sessionId, bootstrapped: false };
    set({ phase: 'requesting-session', errorMessage: null, mode: null, lastUserMessage: null });
    try {
      await ensureMicrophone();
    } catch (err) {
      if (myGen !== startGen) return;
      liveStart = null;
      settleDeferredHolds();
      set({ phase: 'error', errorMessage: formatConnectError(err) });
      return;
    }
    // Ended during the permission prompt: nothing was reserved, and nothing should be.
    if (myGen !== startGen) return;
    await pendingSettles;
    if (myGen !== startGen) return;
    await establishConnection(set, myGen, { sessionId, reasoningModelId, onSessionResolved }, false);
  },

  end: async () => {
    // Supersede the active attempt first: any in-flight startSession, any pending
    // reconnect timer, and any late SDK callback (incl. the onDisconnect this
    // triggers) now see a changed generation and no-op, so reconciliation happens
    // exactly once - here.
    startGen++;
    liveStart = null;
    settleDeferredHolds();
    clearReconnectTimer();
    stopHeartbeat();
    reconnectAttempts = 0;
    const conv = conversation;
    const sid = activeSessionId;
    conversation = null;
    activeSessionId = null;
    set({ phase: 'ended', mode: null });
    // Chained synchronously so a restart issued before the transport closes still waits for this /end.
    const closed = conv ? conv.endSession().catch(() => {}) : Promise.resolve();
    pendingSettles = pendingSettles.then(() => closed);
    await queueSettle(sid);
  },
}));
