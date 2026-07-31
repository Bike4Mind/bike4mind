// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Keep @bike4mind/common real so the sensitive/non-sensitive split comes from the actual
// settingsMap. Mock only the infra + middleware seams.
let stored: Record<string, unknown> | null = null;
const findOneAndUpdate = vi.fn();

vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: () => ({ lean: () => Promise.resolve(stored) }),
    findOneAndUpdate: (...args: unknown[]) => findOneAndUpdate(...args),
  },
}));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ put: (handler: (...a: unknown[]) => unknown) => handler }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (handler: (...a: unknown[]) => unknown) => handler,
}));
vi.mock('@server/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'a'.repeat(64) } }));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  materializePublicSettingsArtifactSafe: vi.fn(() => Promise.resolve()),
}));

import handler from '../update';
import { SENSITIVE_SETTING_MASK } from '@bike4mind/common';

/** Stage what findOneAndUpdate returns, mirroring a Mongoose doc (toObject + field access). */
const stageWriteResult = (settingName: string, settingValue: unknown) => {
  findOneAndUpdate.mockResolvedValue({
    settingName,
    settingValue,
    toObject: () => ({ settingName, settingValue }),
  });
};

const runHandler = async (key: string, value: unknown, extra: Record<string, unknown> = {}) => {
  const json = vi.fn((x: unknown) => x);
  const req = {
    user: { isAdmin: true },
    ability: { can: () => true },
    body: { key, value, ...extra },
    logger: { info: vi.fn(), error: vi.fn() },
  };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<unknown>)(req, { json });
  return json.mock.calls[0][0] as { settingName: string; settingValue: unknown };
};

describe('settings/update sensitive value handling', () => {
  beforeEach(() => {
    stored = null;
    findOneAndUpdate.mockReset();
    vi.clearAllMocks();
  });

  it('writes a newly submitted secret through', async () => {
    stageWriteResult('anthropicDemoKey', 'sk-ant-api03-brandnew');
    await runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'anthropicDemoKey' },
      { $set: { settingValue: 'sk-ant-api03-brandnew' } },
      expect.anything()
    );
  });

  it('never echoes the submitted secret back in the write response', async () => {
    stageWriteResult('anthropicDemoKey', 'sk-ant-api03-brandnew');
    const result = await runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew');

    expect(result.settingValue).toBe(`${SENSITIVE_SETTING_MASK}dnew`);
    expect(JSON.stringify(result)).not.toContain('sk-ant-api03-brandnew');
  });

  it('treats a mask written back as "keep the stored secret" and does not overwrite it', async () => {
    stored = { settingName: 'anthropicDemoKey', settingValue: 'sk-ant-api03-original' };
    const result = await runHandler('anthropicDemoKey', `${SENSITIVE_SETTING_MASK}inal`);

    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(result.settingValue).toBe(`${SENSITIVE_SETTING_MASK}inal`);
    expect(JSON.stringify(result)).not.toContain('sk-ant-api03-original');
  });

  it('rejects a mask write-back when nothing is stored, rather than persisting asterisks', async () => {
    stored = null;
    await expect(runHandler('anthropicDemoKey', `${SENSITIVE_SETTING_MASK}inal`)).rejects.toThrow();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('refuses to clear a sensitive setting without explicit intent', async () => {
    // The client guards its own accidental-empty path, but the server must not accept a
    // credential-destroying write that merely omits a value. This is the one destructive
    // case the PR would otherwise leave guarded only in the browser.
    await expect(runHandler('anthropicDemoKey', '')).rejects.toThrow(/confirmClear/);
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('allows a deliberate clear when intent is explicit', async () => {
    stageWriteResult('anthropicDemoKey', '');
    await runHandler('anthropicDemoKey', '', { confirmClear: true });

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'anthropicDemoKey' },
      { $set: { settingValue: '' } },
      expect.anything()
    );
  });

  it('does not require intent to clear a non-sensitive setting', async () => {
    // The guard is scoped to isSensitive - emptying an ordinary string setting is not
    // destructive and must not suddenly need a flag.
    stageWriteResult('tagLineMain', '');
    await runHandler('tagLineMain', '');
    expect(findOneAndUpdate).toHaveBeenCalled();
  });

  it('leaves non-sensitive settings echoed in full', async () => {
    stageWriteResult('enforceMFA', 'true');
    const result = await runHandler('enforceMFA', 'true');
    expect(result.settingValue).toBe('true');
  });
});
