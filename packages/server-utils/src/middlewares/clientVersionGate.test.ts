import { describe, it, expect, vi, beforeEach } from 'vitest';
import { settingsMap, UpgradeRequiredError, type SettingKey } from '@bike4mind/common';

const { getSettingsMapMock } = vi.hoisted(() => ({ getSettingsMapMock: vi.fn() }));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: {} }));
// getSettingsValue stands in for the real scoped read: the setting's own schema, default on a bad row.
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: getSettingsMapMock,
  getSettingsValue: (key: SettingKey, settings: Record<string, string>) => {
    const setting = settingsMap[key as keyof typeof settingsMap];
    const parsed = setting.schema.safeParse(settings[key]);
    return parsed.success ? parsed.data : setting.defaultValue;
  },
}));

import { __resetClientVersionGateCache, checkClientVersion } from './clientVersionGate';

const declared = (version: string) => ({ 'x-client-name': 'b4m-sdk-ts', 'x-client-version': version });
const storeMinimums = (value: unknown) =>
  getSettingsMapMock.mockResolvedValue({ minimumClientVersions: JSON.stringify(value) });

describe('checkClientVersion', () => {
  beforeEach(() => {
    __resetClientVersionGateCache();
    getSettingsMapMock.mockReset();
  });

  it('never gates, or reads the setting for, a request without the headers', async () => {
    storeMinimums({ 'b4m-sdk-ts': '9.0.0' });
    await expect(checkClientVersion({})).resolves.toBeUndefined();
    expect(getSettingsMapMock).not.toHaveBeenCalled();
  });

  it('is off while no minimum is configured', async () => {
    getSettingsMapMock.mockResolvedValue({});
    await expect(checkClientVersion(declared('0.0.1'))).resolves.toBeUndefined();
  });

  it('lets a client exactly at the minimum through', async () => {
    storeMinimums({ 'b4m-sdk-ts': '2.1.0' });
    await expect(checkClientVersion(declared('2.1.0'))).resolves.toBeUndefined();
  });

  it('answers 426 with the minimum for a client one patch below it', async () => {
    storeMinimums({ 'b4m-sdk-ts': '2.1.0' });
    const error = await checkClientVersion(declared('2.0.9'));
    expect(error).toBeInstanceOf(UpgradeRequiredError);
    expect(error?.statusCode).toBe(426);
    expect(error?.additionalInfo).toEqual({
      errorCode: 'upgrade_required',
      client_name: 'b4m-sdk-ts',
      minimum_version: '2.1.0',
    });
  });

  it('does not gate a client the setting does not list', async () => {
    storeMinimums({ 'other-client': '2.1.0' });
    await expect(checkClientVersion(declared('0.0.1'))).resolves.toBeUndefined();
  });

  it('fails open on a malformed setting row', async () => {
    getSettingsMapMock.mockResolvedValue({ minimumClientVersions: '{"b4m-sdk-ts": "two"}' });
    await expect(checkClientVersion(declared('0.0.1'))).resolves.toBeUndefined();
  });

  it('fails open, and logs once per TTL, when the settings read throws', async () => {
    getSettingsMapMock.mockRejectedValue(new Error('db down'));
    const logger = { warn: vi.fn() };
    await expect(checkClientVersion(declared('0.0.1'), logger)).resolves.toBeUndefined();
    await expect(checkClientVersion(declared('0.0.1'), logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(getSettingsMapMock).toHaveBeenCalledTimes(1);
  });

  it('caches the setting between requests', async () => {
    storeMinimums({ 'b4m-sdk-ts': '2.1.0' });
    await checkClientVersion(declared('2.1.0'));
    await checkClientVersion(declared('2.0.0'));
    expect(getSettingsMapMock).toHaveBeenCalledTimes(1);
  });
});
