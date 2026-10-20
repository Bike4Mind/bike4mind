import { describe, it, expect, vi } from 'vitest';
import { authSessionService } from '@bike4mind/services';

const create = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ oauthRefreshTokenRepository: { create } }));

import { mintRefreshFamily, refreshFamilyExpiresAt } from './oauthRefreshToken';

const DAY = 24 * 60 * 60 * 1000;

describe('refreshFamilyExpiresAt', () => {
  it('slides to now + 30d while under the cap', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const now = new Date(created.getTime() + 10 * DAY);
    expect(refreshFamilyExpiresAt(created, now).getTime()).toBe(now.getTime() + 30 * DAY);
  });

  it('never slides past createdAt + 90d', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const now = new Date(created.getTime() + 80 * DAY);
    expect(refreshFamilyExpiresAt(created, now).getTime()).toBe(created.getTime() + 90 * DAY);
  });
});

describe('mintRefreshFamily', () => {
  it('stores only the sha256 of the secret and returns <familyId>.<secret>', async () => {
    const token = await mintRefreshFamily({ userId: 'u1', clientId: 'c1', scopes: ['openid'], tokenVersion: 2 });

    const parsed = authSessionService.parseRefreshToken(token);
    expect(parsed).not.toBeNull();
    const stored = create.mock.calls[0][0];
    expect(stored).toMatchObject({ familyId: parsed!.sid, userId: 'u1', clientId: 'c1', tokenVersion: 2 });
    expect(stored.tokenHash).toBe(authSessionService.hashRefreshSecret(parsed!.secret));
    expect(JSON.stringify(stored)).not.toContain(parsed!.secret);
  });
});
