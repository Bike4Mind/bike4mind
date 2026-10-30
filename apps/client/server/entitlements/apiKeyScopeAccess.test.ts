// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  entitlements: [] as string[],
  hearth: undefined as unknown,
  getRequestEntitlements: vi.fn(),
  getUserEntitlements: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingByName: vi.fn(async () => h.hearth) }));
vi.mock('./index', () => ({
  getRequestEntitlements: h.getRequestEntitlements.mockImplementation(async () => h.entitlements),
  getUserEntitlements: h.getUserEntitlements.mockImplementation(async () => h.entitlements),
}));

import { resolveApiKeyScopeAccess, resolveApiKeyScopeAccessForUser } from './apiKeyScopeAccess';

const req = (user: Record<string, unknown>) => ({ user }) as unknown as Parameters<typeof resolveApiKeyScopeAccess>[0];

describe('resolveApiKeyScopeAccess', () => {
  beforeEach(() => {
    h.entitlements = [];
    h.hearth = undefined;
    h.getRequestEntitlements.mockReset().mockImplementation(async () => h.entitlements);
    h.getUserEntitlements.mockReset().mockImplementation(async () => h.entitlements);
  });

  it('grants nothing to a plain user with no product entitlements and Hearth off', async () => {
    h.hearth = false;
    expect(await resolveApiKeyScopeAccess(req({ id: 'u1', tags: [] }))).toEqual({
      hasOptiAccess: false,
      hasOverwatchAccess: false,
      hearthEnabled: false,
      bypass: false,
      entitlements: new Set(),
    });
  });

  it('grants each product from its own entitlement', async () => {
    h.entitlements = ['overwatch:pro'];
    const access = await resolveApiKeyScopeAccess(req({ id: 'u1', tags: [] }));
    expect(access.hasOverwatchAccess).toBe(true);
    expect(access.hasOptiAccess).toBe(false);
    expect(access.entitlements).toEqual(new Set(['overwatch:pro']));
  });

  it('lets admins and developers bypass the entitlement arms without resolving entitlements', async () => {
    for (const user of [
      { id: 'a', isAdmin: true },
      { id: 'd', tags: ['developer'] },
    ]) {
      const access = await resolveApiKeyScopeAccess(req(user));
      expect(access.hasOptiAccess && access.hasOverwatchAccess && access.bypass).toBe(true);
      expect(access.entitlements.size).toBe(0);
    }
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
  });

  it('reads Hearth from the EnableHearth admin setting', async () => {
    h.hearth = 'true';
    expect((await resolveApiKeyScopeAccess(req({ id: 'u1', isAdmin: true }))).hearthEnabled).toBe(true);
  });

  it('loads the target user, including verified email and tags, independently of the request', async () => {
    const target = { id: 'target', tags: ['acme:pro'], email: 'target@example.com', emailVerified: true };
    h.entitlements = ['acme:pro'];

    const access = await resolveApiKeyScopeAccessForUser(target);

    expect(h.getUserEntitlements).toHaveBeenCalledExactlyOnceWith(target);
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
    expect(access.bypass).toBe(false);
    expect(access.entitlements).toEqual(new Set(['acme:pro']));
  });

  it.each([
    { id: 'admin', isAdmin: true },
    { id: 'developer', tags: ['developer'] },
  ])('applies the documented bypass to target $id without loading entitlements', async target => {
    const access = await resolveApiKeyScopeAccessForUser(target);

    expect(access.bypass).toBe(true);
    expect(access.entitlements.size).toBe(0);
    expect(h.getUserEntitlements).not.toHaveBeenCalled();
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
  });

  it('propagates a target entitlement lookup failure instead of returning access', async () => {
    const failure = new Error('entitlement lookup unavailable');
    h.getUserEntitlements.mockRejectedValueOnce(failure);

    await expect(resolveApiKeyScopeAccessForUser({ id: 'target' })).rejects.toBe(failure);
  });

  it('propagates a request entitlement lookup failure instead of returning access', async () => {
    const failure = new Error('entitlement lookup unavailable');
    h.getRequestEntitlements.mockRejectedValueOnce(failure);

    await expect(resolveApiKeyScopeAccess(req({ id: 'u1' }))).rejects.toBe(failure);
  });
});
