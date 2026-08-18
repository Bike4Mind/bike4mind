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
// Deterministic stand-ins for the shared crypto. `enc:` marks ciphertext so the tests can
// assert a value was encrypted at rest without depending on real AES output. update.ts pulls
// encryptSecret/isEncrypted/isValidEncryptionKey through @server/security/secretEncryption,
// which re-exports from @bike4mind/utils/security, so mocking the subpath covers those too.
vi.mock('@bike4mind/utils/security', () => ({
  decryptAtRest: (v: unknown) => (typeof v === 'string' && v.startsWith('enc:') ? v.slice(4) : v),
  encryptSecret: (v: string) => `enc:${v}`,
  isEncrypted: (v: unknown) => typeof v === 'string' && v.startsWith('enc:'),
  isValidEncryptionKey: (k: unknown) => typeof k === 'string' && k.length === 64,
}));
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
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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

  it('encrypts a newly submitted secret at rest, never storing the plaintext', async () => {
    stageWriteResult('anthropicDemoKey', 'enc:sk-ant-api03-brandnew');
    await runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew');

    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'anthropicDemoKey' },
      { $set: { settingValue: 'enc:sk-ant-api03-brandnew' } },
      expect.anything()
    );
    // The plaintext must never be the value handed to the store.
    const storedArg = findOneAndUpdate.mock.calls[0][1] as { $set: { settingValue: string } };
    expect(storedArg.$set.settingValue).not.toBe('sk-ant-api03-brandnew');
  });

  it('never echoes the submitted secret back in the write response', async () => {
    stageWriteResult('anthropicDemoKey', 'sk-ant-api03-brandnew');
    const result = await runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew');

    expect(result.settingValue).toBe(`${SENSITIVE_SETTING_MASK}dnew`);
    expect(JSON.stringify(result)).not.toContain('sk-ant-api03-brandnew');
  });

  it('treats a mask written back as "keep the stored secret" and does not overwrite it', async () => {
    // Stored value is ciphertext; the preserve path must decrypt before masking so the
    // response carries the real last-4, and must never expose the plaintext.
    stored = { settingName: 'anthropicDemoKey', settingValue: 'enc:sk-ant-api03-original' };
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

  it('stores a non-sensitive string verbatim, never encrypting it', async () => {
    stageWriteResult('tagLineMain', 'Welcome aboard');
    await runHandler('tagLineMain', 'Welcome aboard');
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'tagLineMain' },
      { $set: { settingValue: 'Welcome aboard' } },
      expect.anything()
    );
  });

  it('refuses to persist a sensitive value when no valid encryption key is configured', async () => {
    // Fail closed: a misconfigured stage must not silently store a provider key in plaintext.
    vi.stubGlobal('__noop__', undefined);
    const { Config } = (await import('@server/utils/config')) as unknown as {
      Config: { SECRET_ENCRYPTION_KEY: string };
    };
    const original = Config.SECRET_ENCRYPTION_KEY;
    Config.SECRET_ENCRYPTION_KEY = 'too-short';
    try {
      await expect(runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew')).rejects.toThrow(/SECRET_ENCRYPTION_KEY/);
      expect(findOneAndUpdate).not.toHaveBeenCalled();
    } finally {
      Config.SECRET_ENCRYPTION_KEY = original;
    }
  });

  it('degrades to plaintext (does not fail closed) on self-host without a key, matching ApiKeyModel', async () => {
    // A self-host that has not run the openssl step must still be able to save a sensitive,
    // local-only setting like ollamaBackend, exactly as the per-user provider-key path allows.
    const { Config } = (await import('@server/utils/config')) as unknown as {
      Config: { SECRET_ENCRYPTION_KEY: string };
    };
    const originalKey = Config.SECRET_ENCRYPTION_KEY;
    const originalSelfHost = process.env.B4M_SELF_HOST;
    Config.SECRET_ENCRYPTION_KEY = 'too-short';
    process.env.B4M_SELF_HOST = 'true';
    stageWriteResult('ollamaBackend', 'http://localhost:11434');
    try {
      await runHandler('ollamaBackend', 'http://localhost:11434');
      // Stored verbatim (plaintext), and crucially the write was NOT rejected.
      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { settingName: 'ollamaBackend' },
        { $set: { settingValue: 'http://localhost:11434' } },
        expect.anything()
      );
    } finally {
      Config.SECRET_ENCRYPTION_KEY = originalKey;
      if (originalSelfHost === undefined) delete process.env.B4M_SELF_HOST;
      else process.env.B4M_SELF_HOST = originalSelfHost;
    }
  });
});
