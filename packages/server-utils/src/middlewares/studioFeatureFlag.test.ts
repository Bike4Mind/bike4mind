import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

const { getSettingByNameMock } = vi.hoisted(() => ({ getSettingByNameMock: vi.fn() }));

vi.mock('@bike4mind/utils', () => ({ getSettingByName: getSettingByNameMock }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));

import { isStudioFeatureEnabled, requireStudioFeature } from './studioFeatureFlag';

const mkCtx = (user?: { isAdmin?: boolean }) => {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), json } as unknown as Response;
  const req = { requestId: 'r1', user } as unknown as Request;
  const next = vi.fn();
  return { req, res, next, json };
};

beforeEach(() => getSettingByNameMock.mockReset());

describe('isStudioFeatureEnabled', () => {
  it('is off by default, even for an admin', async () => {
    getSettingByNameMock.mockResolvedValue(null);
    await expect(isStudioFeatureEnabled('image', { isAdmin: true })).resolves.toBe(false);
  });

  it('stays closed to a non-admin with the flag on, without reading the setting', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    await expect(isStudioFeatureEnabled('image', { isAdmin: false })).resolves.toBe(false);
    await expect(isStudioFeatureEnabled('image', undefined)).resolves.toBe(false);
    expect(getSettingByNameMock).not.toHaveBeenCalled();
  });

  it('opens for an admin with the flag on, reading that feature setting', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    await expect(isStudioFeatureEnabled('productions', { isAdmin: true })).resolves.toBe(true);
    expect(getSettingByNameMock).toHaveBeenCalledWith('EnableStudioProductions', expect.anything());
  });
});

describe('requireStudioFeature', () => {
  it('answers 403 to a non-admin when the flag is on', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next, json } = mkCtx({ isAdmin: false });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FEATURE_DISABLED' }));
  });

  it('answers 403 to an admin when the flag is off', async () => {
    getSettingByNameMock.mockResolvedValue(false);
    const { req, res, next } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('admits an admin when the flag is on', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('fails closed with 500 when the settings read throws', async () => {
    getSettingByNameMock.mockRejectedValueOnce(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { req, res, next } = mkCtx({ isAdmin: true });
    await requireStudioFeature('createV2')(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
