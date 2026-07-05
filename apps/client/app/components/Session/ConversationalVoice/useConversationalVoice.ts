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

// Reconcile the up-front credit reservation down to the actual call duration.
// Best-effort: a failure just leaves the upfront hold in place - it must never
// block teardown or surface an error to the user. Safe to call more than once
// (the endpoint is idempotent), so both end() and a natural onDisconnect use it.
async function reconcileVoiceSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    await api.post(`/api/voice/v2/sessions/${sessionId}/end`, {});
  } catch {
    // ignore - reservation reconciliation is not user-blocking
  }
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
    activeSessionId = null;
    set({
      phase: 'error',
      errorMessage: `Failed to ${isReconnect ? 'reconnect' : 'create'} voice session: ${formatSessionsError(err)}`,
    });
    return;
  }

  // Superseded during the /sessions request - don't open a connection we'd orphan.
  if (isStale()) return;

  activeSessionId = bootstrap.session?.id ?? null;
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
        set({ phase: 'connected', errorMessage: null });
      },
      onDisconnect: details => {
        if (isStale()) return;
        conversation = null;
        // Abnormal close (network drop - common on mobile) -> bounded auto-reconnect
        // on the SAME session. A user-/agent-initiated end is a real end: reconcile
        // the credit hold and stop.
        if (details.reason === 'error' && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          scheduleReconnect(set, myGen, ctx);
          return;
        }
        const sid = activeSessionId;
        activeSessionId = null;
        set({
          phase: 'ended',
          mode: null,
          ...(details.reason === 'error'
            ? { errorMessage: details.message || 'Voice connection lost. Tap to start again.' }
            : {}),
        });
        void reconcileVoiceSession(sid);
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
    activeSessionId = null;
    set({ phase: 'error', errorMessage: formatConnectError(err) });
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
    set({ phase: 'requesting-session', errorMessage: null, mode: null, lastUserMessage: null });
    await establishConnection(set, myGen, { sessionId, reasoningModelId, onSessionResolved }, false);
  },

  end: async () => {
    // Supersede the active attempt first: any in-flight startSession, any pending
    // reconnect timer, and any late SDK callback (incl. the onDisconnect this
    // triggers) now see a changed generation and no-op, so reconciliation happens
    // exactly once - here.
    startGen++;
    clearReconnectTimer();
    reconnectAttempts = 0;
    const conv = conversation;
    const sid = activeSessionId;
    conversation = null;
    activeSessionId = null;
    set({ phase: 'ended', mode: null });
    if (conv) {
      try {
        await conv.endSession();
      } catch {
        // already torn down
      }
    }
    await reconcileVoiceSession(sid);
  },
}));
