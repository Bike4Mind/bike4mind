// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockEmit, mockGetSetting, mockUserUpdate, mockUpdateOne } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockGetSetting: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockUpdateOne: vi.fn(),
}));
vi.mock('./emitActiveEvent', () => ({ HOST_PRODUCT_ID: 'bike4mind', emitProductEvent: mockEmit }));
vi.mock('@server/utils/config', () => ({ Config: { OVERWATCH_PSEUDONYM_SALT: 'test-salt' } }));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: mockGetSetting },
  userRepository: { update: mockUserUpdate },
  User: { updateOne: mockUpdateOne },
}));

import { APP_DECISION_COOKIE } from '@client/lib/consentCookies';
import { pseudonymize } from './pseudonymize';
import { stableEventId } from './signupEvents';
import {
  emitFunnelEvent,
  isSyntheticIdentity,
  parseDomainList,
  recordFirstChatValue,
  recordFirstValue,
  recordSignupAcquisition,
  toUserAcquisition,
} from './funnel';

const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v));
const reqWith = (cookie: string) => ({ headers: { cookie } });
const TOUCH_COOKIES = `b4m_app_first_touch=${enc({ source: 'reddit', campaign: 'launch' })}; b4m_last_touch=${enc({ source: 'email' })}`;

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue(undefined);
  mockGetSetting.mockResolvedValue('');
  mockUserUpdate.mockResolvedValue(null);
  mockUpdateOne.mockResolvedValue({ modifiedCount: 1 });
});

describe('parseDomainList', () => {
  it('splits on commas and whitespace, lower-cases, and drops a leading @', () => {
    expect(parseDomainList(' Test.Example , @qa.example.org\nfoo.dev ')).toEqual([
      'test.example',
      'qa.example.org',
      'foo.dev',
    ]);
  });

  it.each([undefined, null, 3, ''])('reads %s as no domains', raw => {
    expect(parseDomainList(raw)).toEqual([]);
  });
});

describe('isSyntheticIdentity', () => {
  it('flags the persona- username prefix regardless of domains', () => {
    expect(isSyntheticIdentity({ username: 'persona-alice', email: 'a@real.com' }, [])).toBe(true);
    expect(isSyntheticIdentity({ username: 'Persona-Bob' }, [])).toBe(true);
  });

  it('flags a configured domain and its subdomains, not look-alikes', () => {
    const domains = ['test.example'];
    expect(isSyntheticIdentity({ username: 'u', email: 'x@test.example' }, domains)).toBe(true);
    expect(isSyntheticIdentity({ username: 'u', email: 'x@Sub.Test.Example' }, domains)).toBe(true);
    expect(isSyntheticIdentity({ username: 'u', email: 'x@nottest.example' }, domains)).toBe(false);
  });

  it('flags nothing by default (empty domain list)', () => {
    expect(isSyntheticIdentity({ username: 'alice', email: 'a@gmail.com' }, [])).toBe(false);
    expect(isSyntheticIdentity({ username: 'alice', email: null }, [])).toBe(false);
  });
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

  it('skips synthetic users', async () => {
    expect(await emitFunnelEvent({ user: { id: 'u1', isSynthetic: true }, event: 'email_verified' })).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws when the emitter rejects', async () => {
    mockEmit.mockRejectedValue(new Error('network'));
    await expect(emitFunnelEvent({ user: { id: 'u1' }, event: 'email_verified' })).resolves.toBe(true);
  });
});

describe('recordFirstValue', () => {
  const now = new Date('2026-10-10T00:01:40Z');
  const user = { id: 'u1', createdAt: new Date('2026-10-10T00:00:00Z') };

  it('sets firstValueAt only where unset and emits first_value with time since signup', async () => {
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalledWith({ _id: 'u1', firstValueAt: null }, { $set: { firstValueAt: now } });
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_value', metadata: { feature: 'chat', secondsSinceSignup: 100 } })
    );
  });

  it('emits nothing when another request already set it', async () => {
    mockUpdateOne.mockResolvedValue({ modifiedCount: 0 });
    expect(await recordFirstValue({ user, feature: 'chat', now })).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('records the stage but emits nothing for a synthetic user', async () => {
    expect(await recordFirstValue({ user: { ...user, isSynthetic: true }, feature: 'chat', now })).toBe(false);
    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('never throws when the write fails', async () => {
    mockUpdateOne.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(recordFirstValue({ user, feature: 'chat', now })).resolves.toBe(false);
  });
});

describe('recordFirstChatValue', () => {
  const user = { id: 'u1', createdAt: new Date() };

  it('costs nothing for a user who already has a first answer', async () => {
    const loadQuestStatus = vi.fn();
    expect(await recordFirstChatValue({ user: { ...user, firstValueAt: new Date() }, loadQuestStatus })).toBe(false);
    expect(loadQuestStatus).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('records a completed answer as chat first_value', async () => {
    expect(await recordFirstChatValue({ user, loadQuestStatus: async () => 'done' })).toBe(true);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'first_value', metadata: expect.objectContaining({ feature: 'chat' }) })
    );
  });

  it.each(['stopped', 'error', undefined])('ignores a quest that ended %s', async status => {
    expect(await recordFirstChatValue({ user, loadQuestStatus: async () => status })).toBe(false);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('never throws when the quest read fails', async () => {
    const loadQuestStatus = () => Promise.reject(new Error('db down'));
    await expect(recordFirstChatValue({ user, loadQuestStatus })).resolves.toBe(false);
  });
});
