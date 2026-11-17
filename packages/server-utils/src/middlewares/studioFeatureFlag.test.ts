import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { Request, Response } from 'express';

const { getSettingByNameMock, getRequestEntitlementsMock } = vi.hoisted(() => ({
  getSettingByNameMock: vi.fn(),
  getRequestEntitlementsMock: vi.fn(),
}));

vi.mock('@bike4mind/utils', () => ({ getSettingByName: getSettingByNameMock }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
vi.mock('../entitlements', () => ({ getRequestEntitlements: getRequestEntitlementsMock }));

import { isStudioFeatureEnabled, requireStudioFeature } from './studioFeatureFlag';

type TestUser = { isAdmin?: boolean; tags?: string[] };

const reqFor = (user?: TestUser | null) => ({ requestId: 'r1', user }) as unknown as Request;

const mkCtx = (user?: TestUser) => {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), json } as unknown as Response;
  const req = { requestId: 'r1', user } as unknown as Request;
  const next = vi.fn();
  return { req, res, next, json };
};

beforeEach(() => {
  getSettingByNameMock.mockReset();
  getRequestEntitlementsMock.mockReset();
});

/** Settings store: every flag on, StudioProductionsAudience as given. */
const withAudience = (audience?: string) =>
  getSettingByNameMock.mockImplementation(async (key: string) =>
    key === 'StudioProductionsAudience' ? audience : true
  );
afterEach(() => vi.restoreAllMocks());

describe('isStudioFeatureEnabled', () => {
  it('is off by default, even for an admin', async () => {
    getSettingByNameMock.mockResolvedValue(null);
    await expect(isStudioFeatureEnabled('image', reqFor({ isAdmin: true }))).resolves.toBe(false);
  });

  it('keeps admin-only Productions closed to a non-admin with the flag on, with no plan read', async () => {
    withAudience('admins');
    await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: false }))).resolves.toBe(false);
    expect(getRequestEntitlementsMock).not.toHaveBeenCalled();
  });

  it('defaults the Productions audience to admins when the setting is unset', async () => {
    withAudience(undefined);
    await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: false, tags: ['Developer'] }))).resolves.toBe(
      false
    );
    await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: true }))).resolves.toBe(true);
  });

  describe('Productions audience paid', () => {
    beforeEach(() => withAudience('paid'));

    it('opens for a paid user', async () => {
      getRequestEntitlementsMock.mockResolvedValue(['plan:paid']);
      const req = reqFor({ isAdmin: false });
      await expect(isStudioFeatureEnabled('productions', req)).resolves.toBe(true);
      expect(getRequestEntitlementsMock).toHaveBeenCalledWith(req);
    });

    it('stays closed for a free user', async () => {
      getRequestEntitlementsMock.mockResolvedValue([]);
      await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: false }))).resolves.toBe(false);
    });

    it('opens for an admin and a developer without reading the plan', async () => {
      await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: true }))).resolves.toBe(true);
      await expect(isStudioFeatureEnabled('productions', reqFor({ tags: ['Developer'] }))).resolves.toBe(true);
      expect(getRequestEntitlementsMock).not.toHaveBeenCalled();
    });

    it('stays closed with the flag off, without reading the plan', async () => {
      getSettingByNameMock.mockImplementation(async (key: string) =>
        key === 'StudioProductionsAudience' ? 'paid' : key !== 'EnableStudioProductions'
      );
      getRequestEntitlementsMock.mockResolvedValue(['plan:paid']);
      await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: false }))).resolves.toBe(false);
      expect(getRequestEntitlementsMock).not.toHaveBeenCalled();
    });

    it('falls back to admins for an unknown audience value', async () => {
      withAudience('everyone');
      getRequestEntitlementsMock.mockResolvedValue(['plan:paid']);
      await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: false }))).resolves.toBe(false);
    });
  });

  it('stays closed with no user, without reading the setting', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    await expect(isStudioFeatureEnabled('createV2', reqFor(undefined))).resolves.toBe(false);
    await expect(isStudioFeatureEnabled('image', reqFor(null))).resolves.toBe(false);
    expect(getSettingByNameMock).not.toHaveBeenCalled();
  });

  it.each(['createV2', 'image'] as const)('opens %s to a non-admin when its settings are on', async feature => {
    getSettingByNameMock.mockResolvedValue(true);
    await expect(isStudioFeatureEnabled(feature, reqFor({ isAdmin: false }))).resolves.toBe(true);
  });

  it('keeps Create v2 closed to a non-admin when the setting is off', async () => {
    getSettingByNameMock.mockResolvedValue(false);
    await expect(isStudioFeatureEnabled('createV2', reqFor({ isAdmin: false }))).resolves.toBe(false);
  });

  it('opens for an admin with the flag on, reading that feature setting', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: true }))).resolves.toBe(true);
    expect(getSettingByNameMock).toHaveBeenCalledWith('EnableStudioProductions', expect.anything());
  });

  it('stays closed to an admin with the feature flag on while Create v2 is off', async () => {
    getSettingByNameMock.mockImplementation(async (key: string) => key !== 'EnableStudioCreateV2');
    await expect(isStudioFeatureEnabled('productions', reqFor({ isAdmin: true }))).resolves.toBe(false);
    await expect(isStudioFeatureEnabled('image', reqFor({ isAdmin: true }))).resolves.toBe(false);
    expect(getSettingByNameMock).toHaveBeenCalledWith('EnableStudioCreateV2', expect.anything());
  });
});

describe('requireStudioFeature', () => {
  it('admits a non-admin to Create v2 when the flag is on', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next } = mkCtx({ isAdmin: false });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers 403 to a non-admin on Create v2 when the flag is off', async () => {
    getSettingByNameMock.mockResolvedValue(false);
    const { req, res, next, json } = mkCtx({ isAdmin: false });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Feature not available', code: 'FEATURE_DISABLED', request_id: 'r1' });
  });

  it('answers 403 to a non-admin on admin-only Productions when the flag is on', async () => {
    withAudience('admins');
    const { req, res, next, json } = mkCtx({ isAdmin: false });
    await requireStudioFeature('productions')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Feature not available', code: 'FEATURE_DISABLED', request_id: 'r1' });
  });

  it('admits a paid user to paid Productions and answers 403 to a free one', async () => {
    withAudience('paid');
    getRequestEntitlementsMock.mockResolvedValueOnce(['plan:paid']);
    const paid = mkCtx({ isAdmin: false });
    await requireStudioFeature('productions')(paid.req, paid.res, paid.next);
    expect(paid.next).toHaveBeenCalled();
    expect(getRequestEntitlementsMock).toHaveBeenCalledWith(paid.req);

    getRequestEntitlementsMock.mockResolvedValueOnce([]);
    const free = mkCtx({ isAdmin: false });
    await requireStudioFeature('productions')(free.req, free.res, free.next);
    expect(free.next).not.toHaveBeenCalled();
    expect(free.res.status).toHaveBeenCalledWith(403);
    expect(free.json).toHaveBeenCalledWith({
      error: 'Feature not available',
      code: 'FEATURE_DISABLED',
      request_id: 'r1',
    });
  });

  it('fails closed with 500 when the plan read throws', async () => {
    withAudience('paid');
    getRequestEntitlementsMock.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { req, res, next, json } = mkCtx({ isAdmin: false });
    await requireStudioFeature('productions')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Unable to verify feature access', request_id: 'r1' });
  });

  it('answers 403 to a caller with no user, without reading the setting', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next, json } = mkCtx();
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Feature not available', code: 'FEATURE_DISABLED', request_id: 'r1' });
    expect(getSettingByNameMock).not.toHaveBeenCalled();
  });

  it('answers 403 to an admin when the flag is off, with the same body as a non-admin', async () => {
    getSettingByNameMock.mockResolvedValue(false);
    const { req, res, next, json } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: 'Feature not available', code: 'FEATURE_DISABLED', request_id: 'r1' });
  });

  it('admits an admin when the flag is on', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fails closed with 500 when the settings read throws', async () => {
    getSettingByNameMock.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    const { req, res, next, json } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ error: 'Unable to verify feature access', request_id: 'r1' });
  });
});
