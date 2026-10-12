import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionFindOne: vi.fn(),
  userFindById: vi.fn(),
  incrementCredits: vi.fn(),
  claimVoiceHold: vi.fn(),
  getSession: vi.fn(),
  createTransaction: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  Connection: { findOne: mocks.connectionFindOne },
  creditTransactionRepository: { createTransaction: mocks.createTransaction },
  modelPriceRepository: { rowsInForce: vi.fn(async () => []) },
  sessionRepository: { claimVoiceHold: mocks.claimVoiceHold },
  usageEventRepository: { record: mocks.recordUsageEvent },
  userRepository: { findById: mocks.userFindById, incrementCredits: mocks.incrementCredits },
}));
vi.mock('@bike4mind/services', () => ({
  sessionService: { getSession: mocks.getSession },
}));
vi.mock('@bike4mind/common', () => ({
  ApiKeyScope: { AI_CHAT: 'ai:chat' },
  CreditHolderType: { User: 'user' },
  VoiceSessionEndedAction: { parse: (body: unknown) => body },
  computeRealtimeVoiceUsd: () => 0.01,
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: vi.fn(async () => ({})),
  getSettingsValue: vi.fn(() => false),
  NotFoundError: class NotFoundError extends Error {},
  usdToCredits: () => 100,
  usdToCreditsStochastic: () => 40,
}));
vi.mock('@server/voice/realtimeVoicePricing', () => ({ pickRealtimeVoiceTier: () => ({ tier: {} }) }));
vi.mock('@server/websocket/connectionScope', () => ({ connectionHoldsScope: () => true }));
vi.mock('@server/websocket/utils', () => ({
  withWebSocketContext: vi.fn(
    (handler: (event: unknown, context: unknown, logger: unknown) => Promise<unknown>) => handler
  ),
  sendToClient: vi.fn(),
}));

import { func } from '../voiceSessionEnded';

// Just opened, so the connected-time floor stays below this frame's usage.
const STARTED = new Date(Date.now() - 1000);
const usage = {
  textInputTokens: 0,
  audioInputTokens: 0,
  textOutputTokens: 0,
  audioOutputTokens: 0,
  textCachedInputTokens: 0,
  audioCachedInputTokens: 0,
};
const event = {
  requestContext: { connectionId: 'conn-1', domainName: 'ws.example', stage: 'test' },
  body: JSON.stringify({ userId: 'user-1', sessionId: 'session-1', model: 'gpt-realtime', usage }),
};
const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
const settle = () => (func as unknown as (...args: unknown[]) => Promise<unknown>)(event, {}, logger);

/**
 * The claim is what stops this frame, a replay, the end endpoint and the stale hold sweep from
 * each refunding the same hold. If it stops gating the credit writes the failure is silent (a
 * double refund), so it is pinned here.
 */
describe('voiceSessionEnded hold claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connectionFindOne.mockResolvedValue({ userId: 'user-1' });
    mocks.userFindById.mockResolvedValue({ id: 'user-1' });
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      voiceReservedCredits: 100,
      voiceSessionStartedAt: STARTED,
    });
    mocks.claimVoiceHold.mockResolvedValue({ billedCredits: null });
    mocks.createTransaction.mockResolvedValue({});
    mocks.recordUsageEvent.mockResolvedValue(undefined);
  });

  it('claims the hold at its start time, then reconciles the reservation', async () => {
    await settle();

    expect(mocks.claimVoiceHold).toHaveBeenCalledWith('session-1', STARTED);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', 60);
    expect(mocks.createTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.incrementCredits.mock.invocationCallOrder[0]
    );
  });

  it('moves no credits and records nothing when another settler claimed the hold first', async () => {
    mocks.claimVoiceHold.mockResolvedValue(null);

    expect(await settle()).toEqual({ statusCode: 200 });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.createTransaction).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it('never reaches the claim for a session with no live hold', async () => {
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      voiceReservedCredits: null,
      voiceSessionStartedAt: null,
    });

    await settle();

    expect(mocks.claimVoiceHold).not.toHaveBeenCalled();
  });
});
