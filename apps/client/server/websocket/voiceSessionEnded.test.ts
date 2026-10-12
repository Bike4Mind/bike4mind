import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory session, ledger and balance: the handler's billing is asserted on what the user ends
// up paying, not on which repository calls it made.
interface FakeSession {
  id: string;
  voiceReservedCredits: number | null;
  voiceSessionStartedAt: Date | null;
  voiceBilledCredits?: number;
}
const state = vi.hoisted(() => ({
  session: null as unknown as FakeSession,
  balance: 0,
  transactions: [] as Array<{ credits: number; transactionId?: string }>,
}));

const sendToClient = vi.hoisted(() => vi.fn());
vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: (handler: (...args: unknown[]) => unknown) => (event: unknown) =>
    handler(event, {}, { info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
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
      state.balance += delta;
    },
  },
  creditTransactionRepository: {
    createTransaction: async (_type: string, data: { credits: number; transactionId?: string }) => {
      if (data.transactionId && state.transactions.some(t => t.transactionId === data.transactionId)) return null;
      state.transactions.push(data);
      return data;
    },
  },
  sessionRepository: {
    addVoiceBilledCredits: async (_id: string, startedAt: Date, credits: number) => {
      if (state.session.voiceSessionStartedAt?.getTime() !== startedAt.getTime()) return null;
      const before = state.session.voiceBilledCredits ?? 0;
      state.session.voiceBilledCredits = before + credits;
      return before;
    },
    closeVoiceHold: async (_id: string, startedAt: Date) => {
      if (state.session.voiceSessionStartedAt?.getTime() !== startedAt.getTime()) return null;
      const billedCredits = state.session.voiceBilledCredits ?? 0;
      state.session = { id: state.session.id, voiceReservedCredits: null, voiceSessionStartedAt: null };
      return { billedCredits };
    },
  },
}));

import { func } from './voiceSessionEnded';
import { shouldReuseVoiceHold } from '@server/voice/voiceSessionLimits';

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
      voiceReservedCredits: HOLD,
      voiceSessionStartedAt: new Date(Date.now() - 60_000),
      voiceBilledCredits: 0,
    };
    state.balance = STARTING_BALANCE - HOLD;
    state.transactions = [];
    sendToClient.mockClear();
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

  it('does not bill a replayed response twice', async () => {
    await send(30, 'resp-1');
    await send(30, 'resp-1');
    await send(0);

    expect(state.transactions).toHaveLength(1);
    expect(charged()).toBe(30);
  });

  it('keeps the hold open across responses, so a reconnect reuses it instead of taking a second one', async () => {
    await send(30, 'resp-1');

    expect(shouldReuseVoiceHold(true, state.session)).toBe(true);
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
    expect(charged()).toBe(0);

    await send(40, 'resp-late');
    expect(charged()).toBe(40);
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
});
