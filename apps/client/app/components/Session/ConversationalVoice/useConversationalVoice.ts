import { create } from 'zustand';
import { Conversation } from '@elevenlabs/client';
import type { Mode } from '@elevenlabs/client';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import axios from 'axios';
import { z } from 'zod';

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

// Failed /end requests wait here and are retried. sessionStorage survives a reload but not a
// closed tab; the server's voiceHoldSweep (apps/workers/src/cron/voiceHoldSweep.ts) settles
// whatever this queue never does, so giving up here never strands a hold.
const PENDING_SETTLEMENTS_KEY = 'voice-pending-settlements';
const PendingSettlementSchema = z.object({
  sessionId: z.string(),
  // The user who held the call: after a sign-out/sign-in in the same tab, another user's
  // entries are dropped instead of replayed under the wrong credentials.
  userId: z.string(),
  attempts: z.number().int().nonnegative(),
});
type PendingSettlement = z.infer<typeof PendingSettlementSchema>;

// With the 60s backoff cap this is roughly 20 minutes of retrying before the sweep takes over.
const MAX_SETTLEMENT_ATTEMPTS = 20;
const INITIAL_SETTLEMENT_RETRY_MS = 5000;
const MAX_SETTLEMENT_RETRY_MS = 60_000;

function currentUserId(): string | null {
  return useUser.getState().currentUser?.id ?? null;
}

function readPendingSettlements(): Map<string, PendingSettlement> {
  if (typeof window === 'undefined') return new Map();
  try {
    const stored = sessionStorage.getItem(PENDING_SETTLEMENTS_KEY);
    if (!stored) return new Map();
    const parsed = z.array(PendingSettlementSchema).parse(JSON.parse(stored));
    return new Map(parsed.map(settlement => [settlement.sessionId, settlement]));
  } catch (err) {
    console.error('Could not restore pending voice credit settlements', err);
    return new Map();
  }
}

const pendingSettlements = readPendingSettlements();
let settlementRetryTimer: ReturnType<typeof setTimeout> | null = null;
let settlementInFlight = false;
let settlementRetryDelayMs = INITIAL_SETTLEMENT_RETRY_MS;

function persistPendingSettlements(): void {
  try {
    if (pendingSettlements.size === 0) {
      sessionStorage.removeItem(PENDING_SETTLEMENTS_KEY);
    } else {
      sessionStorage.setItem(PENDING_SETTLEMENTS_KEY, JSON.stringify([...pendingSettlements.values()]));
    }
  } catch (err) {
    console.error('Could not persist pending voice credit settlements', err);
  }
}

function scheduleSettlementRetry(): void {
  if (settlementRetryTimer || pendingSettlements.size === 0) return;
  settlementRetryTimer = setTimeout(() => {
    settlementRetryTimer = null;
    void drainPendingSettlements();
  }, settlementRetryDelayMs);
  // Back off after scheduling, so the first retry waits the initial delay.
  settlementRetryDelayMs = Math.min(settlementRetryDelayMs * 2, MAX_SETTLEMENT_RETRY_MS);
}

// Network failures, 5xx (provider unverifiable) and 409 (the provider still has the call open)
// can succeed later. Any other status is final: retrying a 403/404 would loop forever.
function isRetryableSettlementError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;
  const status = err.response?.status;
  return status === undefined || status === 409 || status >= 500;
}

function dropPendingSettlement(sessionId: string): void {
  pendingSettlements.delete(sessionId);
  persistPendingSettlements();
}

async function drainPendingSettlements(): Promise<void> {
  if (settlementInFlight || pendingSettlements.size === 0) return;
  settlementInFlight = true;
  try {
    const userId = currentUserId();
    for (const settlement of [...pendingSettlements.values()]) {
      if (settlement.userId !== userId) {
        console.warn('Dropping a voice credit settlement held by another user', settlement.sessionId);
        dropPendingSettlement(settlement.sessionId);
        continue;
      }
      try {
        await api.post(`/api/voice/v2/sessions/${settlement.sessionId}/end`);
        dropPendingSettlement(settlement.sessionId);
        settlementRetryDelayMs = INITIAL_SETTLEMENT_RETRY_MS;
      } catch (err) {
        settlement.attempts += 1;
        if (!isRetryableSettlementError(err) || settlement.attempts >= MAX_SETTLEMENT_ATTEMPTS) {
          console.error('Giving up on voice credit settlement; the server sweep will settle it', err);
          dropPendingSettlement(settlement.sessionId);
          continue;
        }
        persistPendingSettlements();
        console.error('Voice credit settlement failed; retrying', err);
      }
    }
  } finally {
    settlementInFlight = false;
    scheduleSettlementRetry();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void drainPendingSettlements());
  if (pendingSettlements.size > 0) scheduleSettlementRetry();
}

async function reconcileVoiceSession(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  const userId = currentUserId();
  if (!userId) {
    console.error('No signed-in user to settle the voice credit hold; the server sweep will settle it', sessionId);
    return;
  }
  if (!pendingSettlements.has(sessionId)) {
    pendingSettlements.set(sessionId, { sessionId, userId, attempts: 0 });
    persistPendingSettlements();
  }
  await drainPendingSettlements();
}

// Probe the microphone BEFORE bootstrapping: the bootstrap reserves credits, and a
// browser with no (or a denied) mic would otherwise pay for a call that can never
// connect. The tracks are released at once; the SDK reopens the mic itself.
async function ensureMicrophone(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error('Microphone access needs a secure (https) connection or a supported browser.'), {
      name: window.isSecureContext ? 'NotSupportedError' : 'SecurityError',
    });
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  stream.getTracks().forEach(track => track.stop());
}

function formatSessionsError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const data = err.response?.data as { error?: string; detail?: string } | string | undefined;
    // 409: an earlier call on this notebook is still being settled; the server message says so.
    if (status === 409 && typeof data === 'object' && data?.error) return data.error;
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
    // Reconnects exhausted: the original connect's hold is still live, so settle it.
    const sid = activeSessionId;
    activeSessionId = null;
    void reconcileVoiceSession(sid);
    set({
      phase: 'error',
      errorMessage: `Failed to ${isReconnect ? 'reconnect' : 'create'} voice session: ${formatSessionsError(err)}`,
    });
    return;
  }

  // Superseded during the /sessions request - don't open a connection we'd orphan. The server
  // already reserved credits for it, and end() ran before the id was known, so settle it here.
  if (isStale()) {
    if (!isReconnect) void reconcileVoiceSession(bootstrap.session?.id ?? null);
    return;
  }

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
    // The bootstrap above already reserved credits; release them, or the failed
    // call keeps the whole up-front hold.
    const sid = activeSessionId;
    activeSessionId = null;
    void reconcileVoiceSession(sid);
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
    if (sessionId && pendingSettlements.has(sessionId)) {
      await drainPendingSettlements();
      if (myGen !== startGen) return;
      if (pendingSettlements.has(sessionId)) {
        set({
          phase: 'error',
          errorMessage: 'The previous voice call on this notebook is still being settled; try again in a few seconds.',
        });
        return;
      }
    }
    try {
      await ensureMicrophone();
    } catch (err) {
      if (myGen !== startGen) return;
      set({ phase: 'error', errorMessage: formatConnectError(err) });
      return;
    }
    if (myGen !== startGen) return;
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
