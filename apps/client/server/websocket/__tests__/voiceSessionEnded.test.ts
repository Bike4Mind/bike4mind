import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectionFindOne: vi.fn(),
  userFindById: vi.fn(),
  incrementCredits: vi.fn(),
  claimVoiceHold: vi.fn(),
  getSession: vi.fn(),
  subtractCredits: vi.fn(),
  recordUsageEvent: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
  Connection: { findOne: mocks.connectionFindOne },
  creditTransactionRepository: {},
  modelPriceRepository: { rowsInForce: vi.fn(async () => []) },
  sessionRepository: { claimVoiceHold: mocks.claimVoiceHold },
  usageEventRepository: { record: mocks.recordUsageEvent },
  userRepository: { findById: mocks.userFindById, incrementCredits: mocks.incrementCredits },
}));
vi.mock('@bike4mind/services', () => ({
  sessionService: { getSession: mocks.getSession },
  creditService: { subtractCredits: mocks.subtractCredits },
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

const STARTED = new Date('2026-10-11T12:00:00Z');
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
    // One minute into the call, so the open-time floor stays below the reported usage.
    vi.useFakeTimers({ now: new Date(STARTED.getTime() + 60_000) });
    mocks.connectionFindOne.mockResolvedValue({ userId: 'user-1' });
    mocks.userFindById.mockResolvedValue({ id: 'user-1' });
    mocks.getSession.mockResolvedValue({ id: 'session-1', voiceReservedCredits: 100, voiceSessionStartedAt: STARTED });
    mocks.claimVoiceHold.mockResolvedValue(true);
    mocks.recordUsageEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims the hold at its start time, then reconciles the reservation', async () => {
    await settle();

    expect(mocks.claimVoiceHold).toHaveBeenCalledWith('session-1', STARTED);
    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', 60);
    expect(mocks.subtractCredits).toHaveBeenCalledTimes(1);
    expect(mocks.claimVoiceHold.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.incrementCredits.mock.invocationCallOrder[0]
    );
  });

  it('moves no credits and records nothing when another settler claimed the hold first', async () => {
    mocks.claimVoiceHold.mockResolvedValue(false);

    expect(await settle()).toEqual({ statusCode: 200 });
    expect(mocks.incrementCredits).not.toHaveBeenCalled();
    expect(mocks.subtractCredits).not.toHaveBeenCalled();
    expect(mocks.recordUsageEvent).not.toHaveBeenCalled();
  });

  it('never reaches the claim for a session with no live hold', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', voiceReservedCredits: null, voiceSessionStartedAt: null });

    await settle();

    expect(mocks.claimVoiceHold).not.toHaveBeenCalled();
  });

  it('settles a frame reporting less than the open time at no less than that time', async () => {
    // 30 minutes in: the floor is half the 100-credit hold, above the 40 credits the frame reports.
    vi.setSystemTime(new Date(STARTED.getTime() + 30 * 60_000));

    await settle();

    expect(mocks.incrementCredits).toHaveBeenCalledWith('user-1', 50);
    expect(mocks.subtractCredits).toHaveBeenCalledWith(expect.objectContaining({ credits: 50 }), expect.anything());
  });
});
