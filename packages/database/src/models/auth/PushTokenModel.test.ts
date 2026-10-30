import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';
import { PushTokenModel, pushTokenRepository } from './PushTokenModel';
import { authSessionRepository } from './AuthSessionModel';
import { setupMongoTest } from '../../__test__/utils';

setupMongoTest();

const USER_A = new mongoose.Types.ObjectId().toString();
const USER_B = new mongoose.Types.ObjectId().toString();

const registration = (overrides: Record<string, unknown> = {}) => ({
  userId: USER_A,
  sid: 'sid-1',
  kind: 'device' as const,
  platform: 'ios' as const,
  environment: 'sandbox' as const,
  token: 'token-1',
  ...overrides,
});

const session = (sid: string, userId: string) =>
  ({
    sid,
    userId,
    refreshTokenHash: `hash-${sid}`,
    createdVia: 'otc',
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  }) as never;

describe('PushTokenModel repository', () => {
  it('upsert is idempotent: re-registering a token keeps one row and refreshes lastSeenAt', async () => {
    const first = await pushTokenRepository.upsert(registration({ appVersion: '1.0' }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await pushTokenRepository.upsert(registration({ sid: 'sid-2' }));

    expect(await PushTokenModel.countDocuments({})).toBe(1);
    expect(second.sid).toBe('sid-2');
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    // Absent optionals are cleared, not left over from the earlier registration.
    expect(second.appVersion).toBeUndefined();
  });

  it('moves ownership when the same token is registered by another user', async () => {
    await pushTokenRepository.upsert(registration());
    await pushTokenRepository.upsert(registration({ userId: USER_B, sid: 'sid-b' }));

    expect(await pushTokenRepository.findByUser(USER_A, 'device')).toHaveLength(0);
    const owned = await pushTokenRepository.findByUser(USER_B, 'device');
    expect(owned).toHaveLength(1);
    expect(owned[0].sid).toBe('sid-b');
  });

  it('findByUser filters by kind', async () => {
    await pushTokenRepository.upsert(registration());
    await pushTokenRepository.upsert(
      registration({ token: 'activity-1', kind: 'liveActivity', activityId: 'act', questId: 'q' })
    );

    const activities = await pushTokenRepository.findByUser(USER_A, 'liveActivity');
    expect(activities.map(t => t.token)).toEqual(['activity-1']);
    expect(activities[0].questId).toBe('q');
  });

  it('removeByToken succeeds for an unknown token', async () => {
    await pushTokenRepository.upsert(registration());
    expect(await pushTokenRepository.removeByToken('nope')).toBe(false);
    expect(await pushTokenRepository.removeByToken('token-1')).toBe(true);
    expect(await PushTokenModel.countDocuments({})).toBe(0);
  });

  it("removeByToken scoped to a userId leaves another user's token alone", async () => {
    await pushTokenRepository.upsert(registration());
    expect(await pushTokenRepository.removeByToken('token-1', { userId: USER_B })).toBe(false);
    expect(await PushTokenModel.countDocuments({})).toBe(1);
    expect(await pushTokenRepository.removeByToken('token-1', { userId: USER_A })).toBe(true);
  });

  it("removeBySid only removes that session's tokens", async () => {
    await pushTokenRepository.upsert(registration());
    await pushTokenRepository.upsert(registration({ token: 'token-2', sid: 'sid-2' }));

    expect(await pushTokenRepository.removeBySid('sid-1')).toBe(1);
    expect((await PushTokenModel.find({})).map(t => t.token)).toEqual(['token-2']);
  });

  it('rejects an unknown platform', async () => {
    await expect(pushTokenRepository.upsert(registration({ platform: 'palmos' }))).rejects.toThrow();
  });
});

describe('AuthSession revocation prunes push tokens', () => {
  const seed = async () => {
    await authSessionRepository.create(session('sid-1', USER_A));
    await authSessionRepository.create(session('sid-2', USER_A));
    await authSessionRepository.create(session('sid-3', USER_B));
    await pushTokenRepository.upsert(registration({ token: 'a1', sid: 'sid-1' }));
    await pushTokenRepository.upsert(registration({ token: 'a1-live', sid: 'sid-1', kind: 'liveActivity' }));
    await pushTokenRepository.upsert(registration({ token: 'a2', sid: 'sid-2' }));
    await pushTokenRepository.upsert(registration({ token: 'b3', sid: 'sid-3', userId: USER_B }));
  };
  const remaining = async () => (await PushTokenModel.find({})).map(t => t.token).sort();

  it("revokeBySid prunes that sid's tokens and keeps other sids'", async () => {
    await seed();
    await authSessionRepository.revokeBySid('sid-1');
    expect(await remaining()).toEqual(['a2', 'b3']);
  });

  it('revokeBySid still prunes when the session was already revoked', async () => {
    await seed();
    await authSessionRepository.revokeBySid('sid-1');
    await pushTokenRepository.upsert(registration({ token: 'late', sid: 'sid-1' }));
    await authSessionRepository.revokeBySid('sid-1');
    expect(await remaining()).toEqual(['a2', 'b3']);
  });

  it("revokeAllByUserId prunes every token of that user and no one else's", async () => {
    await seed();
    await authSessionRepository.revokeAllByUserId(USER_A);
    expect(await remaining()).toEqual(['b3']);
  });

  it("revokeAllByUserId with exceptSid keeps the surviving session's tokens", async () => {
    await seed();
    await authSessionRepository.revokeAllByUserId(USER_A, { exceptSid: 'sid-2' });
    expect(await remaining()).toEqual(['a2', 'b3']);
  });
});
