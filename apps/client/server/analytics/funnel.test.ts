// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockGetSetting, mockLogEventSafe, mockUserUpdate, mockUpdateOne, mockRewardInviter } = vi.hoisted(
  () => ({
    mockEmit: vi.fn(),
    mockGetSetting: vi.fn(),
    mockLogEventSafe: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockUpdateOne: vi.fn(),
    mockRewardInviter: vi.fn(),
  })
);
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', () => ({
  HOST_PRODUCT_ID: 'bike4mind',
  emitProductEvent: mockEmit,
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEventSafe: mockLogEventSafe }));
vi.mock('@server/referrals/firstAnswerReward', () => ({ rewardInviterForFirstAnswer: mockRewardInviter }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: mockGetSetting },
  userRepository: { update: mockUserUpdate },
  User: { updateOne: mockUpdateOne },
}));

import { APP_DECISION_COOKIE } from '@bike4mind/server-utils/lib/consentCookies';
import { pseudonymize } from '@bike4mind/server-utils/analytics/pseudonymize';
import { stableEventId } from './signupEvents';
import {
  emitEmailVerifiedFunnelEvents,
  emitFunnelEvent,
  emitSignupFunnelEvents,
  recordFirstChatValue,
  recordFirstValue,
  recordSignupAcquisition,
  recordSyntheticIdentity,
  toUserAcquisition,
} from './funnel';

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
const reqWith = (cookie: string) => ({ headers: { cookie } });
const TOUCH_COOKIES = `b4m_app_first_touch=${enc({ source: 'reddit', campaign: 'launch' })}; b4m_last_touch=${enc({ source: 'email' })}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockGetSetting.mockResolvedValue('');
  mockLogEventSafe.mockResolvedValue(undefined);
  mockUserUpdate.mockResolvedValue(null);
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('toUserAcquisition', () => {
  it('is undefined without a touch', () => {
    expect(toUserAcquisition({}, 'otc')).toBeUndefined();
  });

  it('keeps both touches with the method and capture time', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    expect(toUserAcquisition({ firstTouch: { source: 'a' }, lastTouch: { source: 'b' } }, 'google', now)).toEqual({
      firstTouch: { source: 'a' },
      lastTouch: { source: 'b' },
      signupMethod: 'google',
      capturedAt: now,
    });
  });
});

describe('recordSignupAcquisition', () => {
  const user = { id: 'u1', username: 'alice', email: 'a@real.com' };

  it('stores the touches on the user when consent is granted', async () => {
    const out = await recordSignupAcquisition({
      req: reqWith(`${APP_DECISION_COOKIE}=granted; ${TOUCH_COOKIES}`),
      user,
      method: 'otc',
    });
    expect(out.isSynthetic).toBe(false);
    expect(mockUserUpdate).toHaveBeenCalledWith({
      id: 'u1',
      acquisition: {
        firstTouch: { source: 'reddit', campaign: 'launch' },
        lastTouch: { source: 'email' },
        signupMethod: 'otc',
        capturedAt: expect.any(Date),
      },
    });
  });

  it.each(['denied', ''])('stores no touch without granted consent (%s)', async decision => {
    const out = await recordSignupAcquisition({
      req: reqWith(`${decision ? `${APP_DECISION_COOKIE}=${decision}; ` : ''}${TOUCH_COOKIES}`),
      user,
      method: 'otc',
    });
    expect(out.acquisition).toBeUndefined();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it('flags a configured test domain as synthetic even without consent', async () => {
    mockGetSetting.mockResolvedValue('test.example');
    const out = await recordSignupAcquisition({
      req: reqWith(''),
      user: { id: 'u2', username: 'bob', email: 'bob@test.example' },
      method: 'github',
    });
    expect(out.isSynthetic).toBe(true);
    expect(mockUserUpdate).toHaveBeenCalledWith({ id: 'u2', isSynthetic: true });
  });

  it('never throws when the write fails', async () => {
    mockUserUpdate.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordSignupAcquisition({ req: reqWith(`${APP_DECISION_COOKIE}=granted; ${TOUCH_COOKIES}`), user, method: 'otc' })
    ).resolves.toEqual({ isSynthetic: false });
  });

  it('keeps a persona synthetic when the write fails, so it is not sent as a real signup', async () => {
    mockUserUpdate.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      recordSignupAcquisition({
        req: reqWith(''),
        user: { id: 'u3', username: 'persona-qa', email: 'qa@real.example' },
        method: 'otc',
      })
    ).resolves.toEqual({ isSynthetic: true });
    expect(mockUserUpdate).toHaveBeenCalledWith({ id: 'u3', isSynthetic: true });
  });
});

describe('recordSyntheticIdentity', () => {
  it.each([
    [{ id: 'u1', username: 'persona-admin', email: 'a@real.example' }, ''],
    [{ id: 'u2', username: 'admin-seeded', email: 'a@test.example' }, 'test.example'],
  ])(
    'persists a synthetic admin-created account and sends its funnel stages marked with the synthetic lane',
    async (user, domains) => {
      mockGetSetting.mockResolvedValue(domains);

      const isSynthetic = await recordSyntheticIdentity(user);
      await emitSignupFunnelEvents({
        user: { ...user, isSynthetic },
        method: 'admin',
        emailVerified: false,
        creditsGranted: 50,
      });

      expect(isSynthetic).toBe(true);
      expect(mockUserUpdate).toHaveBeenCalledWith({ id: user.id, isSynthetic: true });
      // Both marks travel: the lane says it is a persona, and the admin mark still keeps it out
      // of DAU until its own first request.
      expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
        ['credits_granted', { amount: 50, source: 'signup', method: 'admin', userAction: false, lane: 'synthetic' }],
        ['signup_completed', { method: 'admin', userAction: false, lane: 'synthetic' }],
      ]);
    }
  );
});

describe('emitFunnelEvent', () => {
  it('sends to the host product, keyed once per user, with the stored first touch as utm', async () => {
    const sent = await emitFunnelEvent({
      user: { id: 'u1', acquisition: { firstTouch: { source: 'reddit' } } },
      event: 'credits_granted',
      metadata: { amount: 100, source: 'signup' },
    });
    expect(sent).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith({
      productId: 'bike4mind',
      event: 'credits_granted',
      eventId: stableEventId('credits_granted', 'bike4mind', pseudonymize('u1', 'test-salt')),
      userId: 'u1',
      utm: { source: 'reddit' },
      metadata: { amount: 100, source: 'signup' },
    });
  });

  it("sends a synthetic user's stage marked with the synthetic lane instead of skipping it", async () => {
    expect(await emitFunnelEvent({ user: { id: 'u1', isSynthetic: true }, event: 'email_verified' })).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email_verified', userId: 'u1', metadata: { lane: 'synthetic' } })
    );
  });

  it('lets no caller metadata unmark a synthetic user', async () => {
    await emitFunnelEvent({
      user: { id: 'u1', isSynthetic: true },
      event: 'signup_completed',
      metadata: { lane: 'real' },
    });
    expect(mockEmit.mock.calls[0][0].metadata).toEqual({ lane: 'synthetic' });
  });

  it("leaves a real user's stage unmarked, and sends no empty metadata", async () => {
    await emitFunnelEvent({ user: { id: 'u1', isSynthetic: false }, event: 'email_verified' });
    await emitFunnelEvent({
      user: { id: 'u2', isSynthetic: null },
      event: 'signup_completed',
      metadata: { method: 'otc' },
    });
    expect(mockEmit.mock.calls[0][0]).not.toHaveProperty('metadata');
    expect(mockEmit.mock.calls[1][0].metadata).toEqual({ method: 'otc' });
  });

  it('names the visit the stage happened in, and no session when there is none', async () => {
    await emitFunnelEvent({ user: { id: 'u1' }, event: 'signup_completed', visitId: 'a'.repeat(32) });
    await emitFunnelEvent({ user: { id: 'u2' }, event: 'signup_completed' });

    expect(mockEmit.mock.calls[0][0].sessionId).toBe('a'.repeat(32));
    expect(mockEmit.mock.calls[1][0]).not.toHaveProperty('sessionId');
  });

  it('never throws when the emitter rejects', async () => {
    mockEmit.mockRejectedValue(new Error('network'));
    await expect(emitFunnelEvent({ user: { id: 'u1' }, event: 'email_verified' })).resolves.toBe(true);
  });
});

describe('emitSignupFunnelEvents', () => {
  it('emits the verified, zero-credit and completed stages with one method', async () => {
    await emitSignupFunnelEvents({ user: { id: 'u1' }, method: 'github', emailVerified: true, creditsGranted: 0 });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
      ['email_verified', { method: 'github' }],
      ['credits_granted', { amount: 0, source: 'signup', method: 'github' }],
      ['signup_completed', { method: 'github' }],
    ]);
  });

  it('defers a zero-credit grant for an unverified signup but still emits signup_completed', async () => {
    await emitSignupFunnelEvents({ user: { id: 'u1' }, method: 'github', emailVerified: false, creditsGranted: 0 });

    expect(mockEmit.mock.calls.map(([event]) => event.event)).toEqual(['signup_completed']);
  });

  it('emits credits_granted for an unverified signup that was granted credits', async () => {
    await emitSignupFunnelEvents({ user: { id: 'u1' }, method: 'github', emailVerified: false, creditsGranted: 50 });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
      ['credits_granted', { amount: 50, source: 'signup', method: 'github' }],
      ['signup_completed', { method: 'github' }],
    ]);
  });

  it('ties every stage of the signup to the visit it came from', async () => {
    const visitId = 'b'.repeat(32);
    await emitSignupFunnelEvents({
      user: { id: 'u1' },
      method: 'github',
      emailVerified: true,
      creditsGranted: 5,
      visitId,
    });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.sessionId])).toEqual([
      ['email_verified', visitId],
      ['credits_granted', visitId],
      ['signup_completed', visitId],
    ]);
  });

  it("marks an admin-created account's stages as no action of its user", async () => {
    // Still a signup, but not a day the new user was active: Overwatch keeps them out of DAU,
    // and out of its new users, until their own first request.
    await emitSignupFunnelEvents({ user: { id: 'u1' }, method: 'admin', emailVerified: true, creditsGranted: 50 });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
      ['email_verified', { method: 'admin', userAction: false }],
      ['credits_granted', { amount: 50, source: 'signup', method: 'admin', userAction: false }],
      ['signup_completed', { method: 'admin', userAction: false }],
    ]);
  });
});

describe('emitEmailVerifiedFunnelEvents', () => {
  it('emits email_verified and credits_granted for a post-launch account', async () => {
    await emitEmailVerifiedFunnelEvents({
      user: { id: 'u1', createdAt: new Date('2026-10-11T00:00:00Z') },
      method: 'otc',
      creditsGranted: 70,
    });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
      ['email_verified', { method: 'otc' }],
      ['credits_granted', { amount: 70, source: 'signup', method: 'otc' }],
    ]);
  });

  it('marks an admin verifying the email as no action of its user', async () => {
    await emitEmailVerifiedFunnelEvents({
      user: { id: 'u1', createdAt: new Date('2026-10-11T00:00:00Z') },
      method: 'admin',
      creditsGranted: 120,
    });

    expect(mockEmit.mock.calls.map(([event]) => [event.event, event.metadata])).toEqual([
      ['email_verified', { method: 'admin', userAction: false }],
      ['credits_granted', { amount: 120, source: 'signup', method: 'admin', userAction: false }],
    ]);
  });

  it('skips a pre-launch or undated account', async () => {
    const early = { id: 'u1', createdAt: new Date('2026-10-10T23:59:59Z') };
    await emitEmailVerifiedFunnelEvents({ user: early, method: 'otc', creditsGranted: 70 });
    await emitEmailVerifiedFunnelEvents({ user: { id: 'u1' }, method: 'otc', creditsGranted: 70 });

    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockRewardInviter).not.toHaveBeenCalled();
  });

  it('checks the inviter reward for a post-launch account', async () => {
    await emitEmailVerifiedFunnelEvents({
      user: { id: 'u1', createdAt: new Date('2026-10-11T00:00:00Z') },
      method: 'otc',
      creditsGranted: 70,
    });

    expect(mockRewardInviter).toHaveBeenCalledWith('u1');
  });
});

describe('recordFirstValue', () => {
  const now = new Date('2026-10-11T00:01:40Z');
  const user = { id: 'u1', createdAt: new Date('2026-10-11T00:00:00Z') };

  it('sets firstValueAt only where unset and emits first_value with time since signup', async () => {
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1', firstValueAt: null }, { $set: { firstValueAt: now } });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_value', metadata: { feature: 'chat', secondsSinceSignup: 100 } })
    );
  });

  it('skips a user who signed up before launch: no write, no emit', async () => {
    const early = { id: 'u1', createdAt: new Date('2026-10-10T23:59:59Z') };
    expect(await recordFirstValue({ user: early, feature: 'chat', now })).toBe(false);
    expect(await recordFirstValue({ user: { id: 'u1' }, feature: 'chat', now })).toBe(false);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('emits once for a post-launch user: a second completion finds firstValueAt set', async () => {
    mockUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 0 });
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(true);
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(false);
    expect(mockEmit).toHaveBeenCalledTimes(1);
  });

  it('emits nothing when another request already set it', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockRewardInviter).not.toHaveBeenCalled();
  });

  it('checks the inviter reward only for the request that recorded it', async () => {
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(true);
    expect(mockRewardInviter).toHaveBeenCalledWith('u1');
  });

  it('skips a pre-launch user without checking the inviter reward', async () => {
    await recordFirstValue({ user: { id: 'u1', createdAt: new Date('2026-10-10T23:59:59Z') }, feature: 'chat', now });
    expect(mockRewardInviter).not.toHaveBeenCalled();
  });

  it('records the stage and emits first_value marked with the synthetic lane for a synthetic user', async () => {
    expect(await recordFirstValue({ user: { ...user, isSynthetic: true }, feature: 'chat', now })).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'first_value',
        metadata: { feature: 'chat', secondsSinceSignup: 100, lane: 'synthetic' },
      })
    );
  });

  it('never throws when the write fails', async () => {
    mockUpdateOne.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordFirstValue({ user, feature: 'chat', now })).resolves.toBe(false);
  });
});

describe('recordFirstChatValue', () => {
  const user = { id: 'u1', createdAt: new Date('2026-10-12T00:00:00Z') };

  it('does not even read the quest for a user who signed up before launch', async () => {
    const loadQuest = vi.fn();
    const early = { id: 'u1', createdAt: new Date('2026-09-01T00:00:00Z') };
    expect(await recordFirstChatValue({ user: early, loadQuest })).toBe(false);
    expect(loadQuest).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('costs nothing for a user who already has a first answer', async () => {
    const loadQuest = vi.fn();
    expect(await recordFirstChatValue({ user: { ...user, firstValueAt: new Date() }, loadQuest })).toBe(false);
    expect(loadQuest).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('records a completed answer as chat first_value', async () => {
    expect(
      await recordFirstChatValue({
        user,
        loadQuest: async () => ({ status: 'done', type: 'message', creditsUsed: 12 }),
      })
    ).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_value', metadata: expect.objectContaining({ feature: 'chat' }) })
    );
    expect(mockLogEventSafe).toHaveBeenCalledWith({
      userId: 'u1',
      type: 'first_answer_credits',
      metadata: { credits: 12 },
    });
  });

  it('logs zero credits when credit enforcement did not record a cost', async () => {
    await recordFirstChatValue({ user, loadQuest: async () => ({ status: 'done', type: 'message' }) });
    expect(mockLogEventSafe).toHaveBeenCalledWith(expect.objectContaining({ metadata: { credits: 0 } }));
  });

  it('does not log credits when another completion already claimed first value', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    await recordFirstChatValue({
      user,
      loadQuest: async () => ({ status: 'done', type: 'message', creditsUsed: 12 }),
    });
    expect(mockLogEventSafe).not.toHaveBeenCalled();
  });

  it.each([
    ['stopped', { status: 'stopped', type: 'message' }],
    ['failed (done with an error reply, e.g. out of credits)', { status: 'done', type: 'error' }],
    ['missing', null],
  ])('ignores a quest that is %s', async (_label, quest) => {
    expect(await recordFirstChatValue({ user, loadQuest: async () => quest })).toBe(false);
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockLogEventSafe).not.toHaveBeenCalled();
  });

  it('never throws when the quest read fails', async () => {
    const loadQuest = () => Promise.reject(new Error('db down'));
    await expect(recordFirstChatValue({ user, loadQuest })).resolves.toBe(false);
  });
});
