// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  entitlements: [] as string[],
  hearth: undefined as unknown,
  getRequestEntitlements: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('@bike4mind/utils', () => ({ getSettingByName: vi.fn(async () => h.hearth) }));
vi.mock('./index', () => ({
  getRequestEntitlements: h.getRequestEntitlements.mockImplementation(async () => h.entitlements),
}));

import { resolveApiKeyScopeAccess } from './apiKeyScopeAccess';

const req = (user: Record<string, unknown>) => ({ user }) as unknown as Parameters<typeof resolveApiKeyScopeAccess>[0];

describe('resolveApiKeyScopeAccess', () => {
  beforeEach(() => {
    h.entitlements = [];
    h.hearth = undefined;
    h.getRequestEntitlements.mockClear();
  });

  it('grants nothing to a plain user with no product entitlements and Hearth off', async () => {
    h.hearth = false;
    expect(await resolveApiKeyScopeAccess(req({ id: 'u1', tags: [] }))).toEqual({
      hasOptiAccess: false,
      hasOverwatchAccess: false,
      hearthEnabled: false,
    });
  });

  it('grants each product from its own entitlement', async () => {
    h.entitlements = ['overwatch:pro'];
    const access = await resolveApiKeyScopeAccess(req({ id: 'u1', tags: [] }));
    expect(access.hasOverwatchAccess).toBe(true);
    expect(access.hasOptiAccess).toBe(false);
  });

  it('lets admins and developers bypass the entitlement arms without resolving entitlements', async () => {
    for (const user of [
      { id: 'a', isAdmin: true },
      { id: 'd', tags: ['developer'] },
    ]) {
      const access = await resolveApiKeyScopeAccess(req(user));
      expect(access.hasOptiAccess && access.hasOverwatchAccess).toBe(true);
    }
    expect(h.getRequestEntitlements).not.toHaveBeenCalled();
  });

  it('reads Hearth from the EnableHearth admin setting', async () => {
    h.hearth = 'true';
    expect((await resolveApiKeyScopeAccess(req({ id: 'u1', isAdmin: true }))).hearthEnabled).toBe(true);
  });
});
