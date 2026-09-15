import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { getSettingByNameMock } = vi.hoisted(() => ({ getSettingByNameMock: vi.fn() }));

vi.mock('@bike4mind/utils', () => ({ getSettingByName: getSettingByNameMock }));
vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
// EnableQuestMaster is a defaultValue:true boolean flag - the case where an admin-disabled
// value must NOT fall back to the (enabled) default.
vi.mock('@bike4mind/common', () => ({ settingsMap: { EnableQuestMaster: { defaultValue: true } } }));

import { requireFeatureEnabled } from './featureFlag';

type SettingKeyArg = Parameters<typeof requireFeatureEnabled>[0];

const mkCtx = () => {
  const json = vi.fn();
  const res = { status: vi.fn(() => ({ json })), json } as unknown as Response;
  const req = { requestId: 'r1' } as unknown as Request;
  const next = vi.fn();
  return { req, res, next };
};

describe('requireFeatureEnabled - admin-disabled defaultValue:true flag stays disabled', () => {
  beforeEach(() => getSettingByNameMock.mockReset());

  it('denies (403) when the stored value is boolean false, not falling back to the default true', async () => {
    getSettingByNameMock.mockResolvedValue(false);
    const { req, res, next } = mkCtx();
    await requireFeatureEnabled('EnableQuestMaster' as SettingKeyArg)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('admits when the flag is enabled', async () => {
    getSettingByNameMock.mockResolvedValue(true);
    const { req, res, next } = mkCtx();
    await requireFeatureEnabled('EnableQuestMaster' as SettingKeyArg)(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('falls back to the default when the setting is absent (null)', async () => {
    getSettingByNameMock.mockResolvedValue(null);
    const { req, res, next } = mkCtx();
    await requireFeatureEnabled('EnableQuestMaster' as SettingKeyArg)(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
