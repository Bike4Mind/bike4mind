import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory session, ledger and balance: the handler's billing is asserted on what the user ends
// up paying, not on which repository calls it made.
interface FakeSession {
  id: string;
  userId: string;
  voiceReservedCredits: number | null;
  voiceSessionStartedAt: Date | null;
  voiceBilledCredits?: number;
  voiceLastActivityAt?: Date | null;
}
const state = vi.hoisted(() => ({
  session: null as unknown as FakeSession,
  balance: 0,
  transactions: [] as Array<{ credits: number; transactionId?: string }>,
  // Runs just before a claim, to stand in for another settler that got there first.
  beforeClaim: null as null | (() => void),
  failIncrement: false,
  failTransaction: false,
  failActivity: false,
}));

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const sendToClient = vi.hoisted(() => vi.fn());
vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: (handler: (...args: unknown[]) => unknown) => (event: unknown) => handler(event, {}, logger),
  sendToClient,
}));
vi.mock('@server/websocket/connectionScope', () => ({ connectionHoldsScope: () => true }));
vi.mock('@server/voice/realtimeVoicePricing', () => ({ pickRealtimeVoiceTier: () => ({ tier: {} }) }));
vi.mock('@bike4mind/common', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // One credit per audio output token keeps the arithmetic readable.
  computeRealtimeVoiceUsd: (_tier: unknown, usage: { audioOutputTokens: number }) => usage.audioOutputTokens,
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usdToCreditsStochastic: (usd: number) => usd,
  getSettingsMap: async () => ({}),
  getSettingsValue: () => true,
}));
vi.mock('@bike4mind/services', () => ({
  sessionService: { getSession: async () => ({ ...state.session }) },
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  Connection: { findOne: async () => ({ userId: 'u1' }) },
  modelPriceRepository: { rowsInForce: async () => [] },
  usageEventRepository: { record: () => Promise.resolve() },
  userRepository: {
    findById: async () => ({ id: 'u1', currentCredits: state.balance }),
    incrementCredits: async (_id: string, delta: number) => {
      if (state.failIncrement) throw new Error('mongo blip');
      state.balance += delta;
    },
  },
  // Rolls the fake session, balance and ledger back on a throw, as a real transaction would.
  withTransaction: async <T>(fn: () => Promise<T>): Promise<T> => {
    const before = { session: { ...state.session }, balance: state.balance, transactions: [...state.transactions] };
    try {
      return await fn();
    } catch (err) {
      Object.assign(state, before);
      throw err;
    }
  },
  creditTransactionRepository: {
    createTransaction: async (_type: string, data: { credits: number; transactionId?: string }) => {
      if (state.failTransaction) throw new Error('mongo blip');
      if (data.transactionId && state.transactions.some(t => t.transactionId === data.transactionId)) return null;
      const row = { ...data, id: `tx-${state.transactions.length + 1}` };
      state.transactions.push(row);
      return row;
    },
  },
  sessionRepository: {
    addVoiceBilledCredits: async (_id: string, startedAt: Date, credits: number) => {
      if (state.session.voiceSessionStartedAt?.getTime() !== startedAt.getTime()) return null;
      if (state.session.voiceBilledCredits === undefined) return null;
      const before = state.session.voiceBilledCredits;
      state.session.voiceBilledCredits = before + credits;
      return before;
    },
    recordVoiceActivity: async (_id: string, at: Date, holdStartedAt?: Date | null) => {
      if (state.failActivity) throw new Error('mongo blip');
      const open = state.session.voiceSessionStartedAt;
      if (open && (!holdStartedAt || holdStartedAt.getTime() === open.getTime())) {
        state.session.voiceLastActivityAt = at;
      }
    },
    claimVoiceHold: async (_id: string, startedAt: Date, options?: { realtimeOnly?: boolean }) => {
      state.beforeClaim?.();
      if (state.session.voiceSessionStartedAt?.getTime() !== startedAt.getTime()) return null;
      if (options?.realtimeOnly && state.session.voiceBilledCredits === undefined) return null;
      const billedCredits = state.session.voiceBilledCredits ?? null;
      state.session = {
        id: state.session.id,
        userId: state.session.userId,
        voiceReservedCredits: null,
        voiceSessionStartedAt: null,
      };
      return { billedCredits };
    },
  },
}));

import { func } from './voiceSessionEnded';
import { realtimeCreditsFloor, shouldReuseVoiceHold } from '@bike4mind/server-utils/voice/voiceSessionLimits';

const HOLD = 100;
const STARTING_BALANCE = 1000;

const frame = (audioOutputTokens: number, responseId?: string) => ({
  requestContext: { connectionId: 'c1', domainName: 'ws.example', stage: 'test' },
  body: JSON.stringify({
    action: 'voice_session_ended',
    userId: 'u1',
    sessionId: 's1',
    model: 'gpt-realtime',
    ...(responseId ? { responseId } : {}),
    usage: {
      audioInputTokens: 0,
      audioCachedInputTokens: 0,
      audioOutputTokens,
      textInputTokens: 0,
      textCachedInputTokens: 0,
      textOutputTokens: 0,
    },
  }),
});
const send = (audioOutputTokens: number, responseId?: string) =>
  (func as unknown as (event: unknown) => Promise<unknown>)(frame(audioOutputTokens, responseId));
const charged = () => STARTING_BALANCE - state.balance;

describe('voiceSessionEnded realtime billing', () => {
  beforeEach(() => {
    // The bootstrap already took the hold out of the balance.
    state.session = {
      id: 's1',
      userId: 'u1',
      voiceReservedCredits: HOLD,
      voiceSessionStartedAt: new Date(Date.now() - 60_000),
      voiceBilledCredits: 0,
    };
    state.balance = STARTING_BALANCE - HOLD;
    state.transactions = [];
    state.beforeClaim = null;
    state.failIncrement = false;
    state.failTransaction = false;
    state.failActivity = false;
    sendToClient.mockClear();
    logger.error.mockClear();
  });

  it('bills every response of a multi-turn call, then refunds the unused hold at the end', async () => {
    await send(30, 'resp-1');
    await send(25, 'resp-2');
    await send(15, 'resp-3');
    expect(state.session.voiceSessionStartedAt).not.toBeNull();
    expect(state.transactions.map(t => t.credits)).toEqual([-30, -25, -15]);

    await send(0);

    expect(charged()).toBe(70);
    expect(state.session.voiceSessionStartedAt).toBeNull();
  });

  it('records each response as the call being alive, so the sweep can settle an abandoned call', async () => {
    await send(30, 'resp-1');

    expect(state.session.voiceLastActivityAt).toBeInstanceOf(Date);
  });

  it('still bills a response whose activity marker cannot be written', async () => {
    state.failActivity = true;

    await send(30, 'resp-1');

    expect(state.session.voiceBilledCredits).toBe(30);
    expect(state.transactions.map(t => t.credits)).toEqual([-30]);
    expect(logger.warn).toHaveBeenCalledWith('voiceSessionEnded: failed to record voice activity', expect.anything());
  });

  it('replaying the same response debits once', async () => {
    await send(30, 'resp-1');
    await send(30, 'resp-1');
    await send(0);

    expect(state.transactions).toHaveLength(1);
    expect(charged()).toBe(30);
  });

  it('keeps the hold open across responses, so a reconnect reuses it instead of taking a second one', async () => {
    await send(30, 'resp-1');

    expect(shouldReuseVoiceHold(true, state.session, true)).toBe(true);
    expect(state.balance).toBe(STARTING_BALANCE - HOLD);
  });

  it('charges responses past the hold from the balance', async () => {
    await send(70, 'resp-1');
    await send(50, 'resp-2');
    expect(charged()).toBe(120);

    await send(0);
    expect(charged()).toBe(120);
  });

  it('still bills a response whose frame arrives after the call was closed', async () => {
    await send(0);
    const atClose = charged();

    await send(40, 'resp-late');
    expect(charged()).toBe(atClose + 40);
  });

  it('settles an older client, which sends one frame per response without an id, on its first frame', async () => {
    await send(30);
    await send(20);

    expect(charged()).toBe(30);
    expect(state.session.voiceSessionStartedAt).toBeNull();
  });

  it('does not end the call as out of credits while the hold still covers it', async () => {
    state.balance = 0;
    await send(30, 'resp-1');
    expect(sendToClient).not.toHaveBeenCalled();

    await send(80, 'resp-2');
    expect(sendToClient).toHaveBeenCalledWith(
      'u1',
      expect.any(String),
      expect.objectContaining({ action: 'voice_credits_exhausted' })
    );
  });

  it('charges a zero-usage frame sent mid-call at least the time the call has been open', async () => {
    const openFor = 30 * 60;
    state.session.voiceSessionStartedAt = new Date(Date.now() - openFor * 1000);
    await send(10, 'resp-1');

    // A modified client reports nothing and asks to close the hold.
    await send(0);

    const floor = realtimeCreditsFloor(HOLD, openFor);
    expect(floor).toBeGreaterThan(10);
    expect(charged()).toBeGreaterThanOrEqual(floor);
    expect(state.transactions.reduce((sum, t) => sum - t.credits, 0)).toBe(charged());
  });

  it('leaves no hold for a call that keeps going after a zero-usage close', async () => {
    state.session.voiceSessionStartedAt = new Date(Date.now() - 30 * 60 * 1000);
    await send(0);
    const atClose = charged();

    // A reconnect must reserve afresh, and further responses are charged from the balance.
    expect(shouldReuseVoiceHold(true, state.session, true)).toBe(false);
    await send(25, 'resp-after-close');
    expect(charged()).toBe(atClose + 25);
  });

  it('never lets reported usage settle a call below its open time', async () => {
    state.session.voiceSessionStartedAt = new Date(Date.now() - 45 * 60 * 1000);

    await send(1);

    expect(charged()).toBe(realtimeCreditsFloor(HOLD, 45 * 60));
  });

  // The claim is what stops this frame, a replay, the end endpoint and the stale hold sweep from
  // each refunding the same hold. If it stops gating the credit writes the failure is silent.
  it('moves no credits and records nothing when another settler claimed the hold first', async () => {
    const newerCall = new Date();
    state.beforeClaim = () => {
      state.session.voiceSessionStartedAt = newerCall;
    };

    await send(0);

    expect(state.balance).toBe(STARTING_BALANCE - HOLD);
    expect(state.transactions).toHaveLength(0);
    expect(state.session.voiceSessionStartedAt).toBe(newerCall);
  });

  it('a failed close leaves the hold open with its markers, so a retry settles it once', async () => {
    await send(30, 'resp-1');
    const startedAt = state.session.voiceSessionStartedAt;
    state.failIncrement = true;

    await expect(send(0)).rejects.toThrow('mongo blip');

    expect(state.session.voiceSessionStartedAt).toEqual(startedAt);
    expect(state.session.voiceReservedCredits).toBe(HOLD);
    expect(state.session.voiceBilledCredits).toBe(30);
    expect(state.session.voiceLastActivityAt).toBeInstanceOf(Date);
    expect(state.balance).toBe(STARTING_BALANCE - HOLD);
    expect(state.transactions.map(t => t.credits)).toEqual([-30]);

    state.failIncrement = false;
    await send(0);

    expect(state.session.voiceSessionStartedAt).toBeNull();
    expect(charged()).toBe(30);
    expect(state.transactions.reduce((sum, t) => sum - t.credits, 0)).toBe(charged());
  });

  it('a failed closing ledger row leaves the balance and the hold unchanged', async () => {
    await send(30, 'resp-1');
    const startedAt = state.session.voiceSessionStartedAt;
    state.failTransaction = true;

    await expect(send(5)).rejects.toThrow('mongo blip');

    expect(state.session.voiceSessionStartedAt).toEqual(startedAt);
    expect(state.session.voiceBilledCredits).toBe(30);
    expect(charged()).toBe(HOLD);
  });

  it("keys the closing ledger row on the hold's start", async () => {
    const startedAt = state.session.voiceSessionStartedAt as Date;

    await send(5);

    expect(state.transactions.map(t => t.transactionId)).toEqual([
      `realtime-voice-close:s1:${startedAt.toISOString()}`,
    ]);
  });

  it('a failed response debit leaves the ledger, billed total and balance unchanged, so a retry bills it once', async () => {
    await send(70, 'resp-1');
    state.failIncrement = true;

    await expect(send(50, 'resp-2')).rejects.toThrow('mongo blip');

    expect(state.transactions.map(t => t.credits)).toEqual([-70]);
    expect(state.session.voiceBilledCredits).toBe(70);
    expect(charged()).toBe(HOLD);
    expect(logger.error).not.toHaveBeenCalled();

    state.failIncrement = false;
    await send(50, 'resp-2');

    expect(state.transactions.map(t => t.credits)).toEqual([-70, -50]);
    expect(charged()).toBe(120);
  });

  it('charges a response frame against a hold without the realtime marker from the balance', async () => {
    delete state.session.voiceBilledCredits;

    await send(30, 'resp-1');

    expect(state.session.voiceBilledCredits).toBeUndefined();
    expect(state.session.voiceSessionStartedAt).not.toBeNull();
    expect(charged()).toBe(HOLD + 30);
  });

  it('leaves an ElevenLabs hold (no realtime marker) untouched by a zero-usage close frame', async () => {
    const startedAt = new Date(Date.now() - (4 * 60 + 50) * 1000);
    state.session.voiceSessionStartedAt = startedAt;
    delete state.session.voiceBilledCredits;

    await send(0);

    expect(state.session.voiceSessionStartedAt).toEqual(startedAt);
    expect(state.session.voiceReservedCredits).toBe(HOLD);
    expect(state.balance).toBe(STARTING_BALANCE - HOLD);
    expect(state.transactions).toHaveLength(0);
  });

  it('still settles a realtime hold from a zero-usage close frame at its floor', async () => {
    const openFor = 10 * 60;
    state.session.voiceSessionStartedAt = new Date(Date.now() - openFor * 1000);

    await send(0);

    expect(state.session.voiceSessionStartedAt).toBeNull();
    expect(charged()).toBe(realtimeCreditsFloor(HOLD, openFor));
  });

  it('closing the session settles the hold exactly once', async () => {
    await send(30);
    const afterClose = { balance: state.balance, transactions: state.transactions.length };

    await send(30);

    expect({ balance: state.balance, transactions: state.transactions.length }).toEqual(afterClose);
  });

  it("ignores frames from a user the notebook is shared with, so the owner's hold is never theirs", async () => {
    state.session.userId = 'owner';

    await send(0);
    await send(30, 'resp-1');

    expect(state.session.voiceSessionStartedAt).not.toBeNull();
    expect(state.session.voiceBilledCredits).toBe(0);
    expect(state.balance).toBe(STARTING_BALANCE - HOLD);
    expect(state.transactions).toHaveLength(0);
  });
});
