// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Keep @bike4mind/common real so the sensitive/non-sensitive split comes from the actual
// settingsMap. Mock only the infra + middleware seams.
let stored: Record<string, unknown> | null = null;
const findOneAndUpdate = vi.fn();
const deleteOne = vi.fn();
const order = vi.hoisted(() => [] as string[]);

vi.mock('@bike4mind/database/infra', () => ({
  AdminSettings: {
    findOne: () => ({ lean: () => Promise.resolve(stored) }),
    findOneAndUpdate: (...args: unknown[]) => {
      order.push('findOneAndUpdate');
      return findOneAndUpdate(...args);
    },
    deleteOne: (...args: unknown[]) => {
      order.push('deleteOne');
      return deleteOne(...args);
    },
  },
}));
vi.mock('@bike4mind/utils', () => ({ invalidateSettingsCache: vi.fn() }));
vi.mock('@bike4mind/database', () => ({
  withTransaction: async (fn: () => Promise<unknown>) => {
    order.push('tx:start');
    const result = await fn();
    order.push('tx:end');
    return result;
  },
}));
const recordAdminActionFromRequest = vi.fn();
vi.mock('@server/utils/adminAudit', () => ({
  recordAdminActionFromRequest: (...args: unknown[]) => {
    order.push('record');
    return recordAdminActionFromRequest(...args);
  },
}));
// Deterministic stand-ins for the shared crypto. `enc:` marks ciphertext so the tests can
// assert a value was encrypted at rest without depending on real AES output. update.ts pulls
// encryptSecret/isEncrypted/isValidEncryptionKey through @bike4mind/server-utils/security/secretEncryption,
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
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { SECRET_ENCRYPTION_KEY: 'a'.repeat(64) } }));
vi.mock('@server/utils/publicSettingsArtifact', () => ({
  materializePublicSettingsArtifactSafe: vi.fn(() => Promise.resolve()),
}));
vi.mock('@server/utils/resolveDefaultEmbeddingModel', () => ({
  resolveDefaultEmbeddingModel: () => Promise.resolve('text-embedding-3-small'),
}));

import handler from '../update';
import { formatUsdPerCredit, MIN_PRICE_PER_CREDIT_USD, SENSITIVE_SETTING_MASK } from '@bike4mind/common';
import { invalidateSettingsCache } from '@bike4mind/utils';
import { adminAuditService } from '@bike4mind/services';

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
    recordAdminActionFromRequest.mockReset().mockResolvedValue(null);
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
    const { Config } = (await import('@bike4mind/server-utils/utils/config')) as unknown as {
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
    const { Config } = (await import('@bike4mind/server-utils/utils/config')) as unknown as {
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

describe('settings/update cleared forced-retrieval absolute floor', () => {
  beforeEach(() => {
    stored = null;
    recordAdminActionFromRequest.mockReset().mockResolvedValue(null);
    findOneAndUpdate.mockReset();
    deleteOne.mockReset();
    vi.mocked(invalidateSettingsCache).mockClear();
  });

  // A stored 75 is honored in every embedding space, so clearing the field must remove the row
  // (back to per-space) rather than store the default.
  it.each(['', '  ', null])('deletes the row instead of storing the default for %j', async value => {
    const res = await runHandler('forcedRetrievalMinSimilarityPct', value);
    expect(deleteOne).toHaveBeenCalledWith({ settingName: 'forcedRetrievalMinSimilarityPct' }, { hardDelete: true });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(invalidateSettingsCache).toHaveBeenCalledWith('forcedRetrievalMinSimilarityPct');
    // null reads as "unset" in the field, distinct from a stored 75; see AdminSettingInputField.
    expect(res.settingValue).toBe(null);
  });

  it('rejects without invalidating the cache or upserting when the delete fails', async () => {
    deleteOne.mockRejectedValue(new Error('db down'));
    await expect(runHandler('forcedRetrievalMinSimilarityPct', '')).rejects.toThrow('db down');
    expect(invalidateSettingsCache).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('still stores an explicit 75 once the caller confirms it is above the measured minimum', async () => {
    stageWriteResult('forcedRetrievalMinSimilarityPct', 75);
    await runHandler('forcedRetrievalMinSimilarityPct', '75', { confirmAboveMeasuredFloor: true });
    expect(deleteOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'forcedRetrievalMinSimilarityPct' },
      { $set: { settingValue: 75 } },
      expect.anything()
    );
  });

  it('refuses a minimum above the one measured for the default embedding model without a confirmation', async () => {
    await expect(runHandler('forcedRetrievalMinSimilarityPct', '75')).rejects.toThrow(
      '75% is above the 58% minimum measured for text-embedding-3-small'
    );
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('stores a minimum at the measured one without a confirmation', async () => {
    stageWriteResult('forcedRetrievalMinSimilarityPct', 58);
    await runHandler('forcedRetrievalMinSimilarityPct', '58');
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'forcedRetrievalMinSimilarityPct' },
      { $set: { settingValue: 58 } },
      expect.anything()
    );
  });

  it('stores the default instead of deleting for a number key without clearDeletesRow', async () => {
    // The delete branch is gated on clearDeletesRow. Without that check a blank save on ANY number
    // key would hard-delete its row; this is the guard on the gate.
    stageWriteResult('forcedRetrievalRelativeFloorPct', 85);
    await runHandler('forcedRetrievalRelativeFloorPct', '');
    expect(deleteOne).not.toHaveBeenCalled();
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'forcedRetrievalRelativeFloorPct' },
      { $set: { settingValue: 85 } },
      expect.anything()
    );
  });
});

describe('settings/update per-credit price floor', () => {
  beforeEach(() => {
    findOneAndUpdate.mockReset();
    vi.mocked(invalidateSettingsCache).mockClear();
  });

  it('refuses to save a per-credit price below the floor', async () => {
    await expect(runHandler('pricePerCredit', String(MIN_PRICE_PER_CREDIT_USD / 2))).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(`at least ${formatUsdPerCredit(MIN_PRICE_PER_CREDIT_USD)},`),
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
    expect(invalidateSettingsCache).not.toHaveBeenCalled();
  });

  it('stores a per-credit price at the floor', async () => {
    stageWriteResult('pricePerCredit', MIN_PRICE_PER_CREDIT_USD);
    await runHandler('pricePerCredit', String(MIN_PRICE_PER_CREDIT_USD));
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'pricePerCredit' },
      { $set: { settingValue: MIN_PRICE_PER_CREDIT_USD } },
      expect.anything()
    );
  });
});

describe('settings/update enforceCredits hosted lock', () => {
  beforeEach(() => {
    stored = null;
    recordAdminActionFromRequest.mockReset().mockResolvedValue(null);
    findOneAndUpdate.mockReset();
    vi.mocked(invalidateSettingsCache).mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('hosted', () => {
    beforeEach(() => {
      vi.stubEnv('B4M_SELF_HOST', undefined);
    });

    it.each([false, 'false'])('refuses to disable credits with %j and records a denied audit entry', async value => {
      await expect(runHandler('enforceCredits', value)).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining('always on for hosted'),
      });
      expect(findOneAndUpdate).not.toHaveBeenCalled();
      expect(invalidateSettingsCache).not.toHaveBeenCalled();
      expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
      expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'settings.admin_settings.denied',
          target: { kind: 'settings', id: 'enforceCredits', displayName: 'enforceCredits' },
        })
      );
    });

    it('stores true', async () => {
      stageWriteResult('enforceCredits', true);
      await runHandler('enforceCredits', true);
      expect(findOneAndUpdate).toHaveBeenCalledWith(
        { settingName: 'enforceCredits' },
        { $set: { settingValue: true } },
        expect.anything()
      );
    });
  });

  it('stores false on a self-host deployment', async () => {
    vi.stubEnv('B4M_SELF_HOST', 'true');
    stageWriteResult('enforceCredits', false);
    await runHandler('enforceCredits', false);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'enforceCredits' },
      { $set: { settingValue: false } },
      expect.anything()
    );
    expect(recordAdminActionFromRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'settings.admin_settings.denied' })
    );
  });
});

describe('settings/update reviewer email list', () => {
  beforeEach(() => {
    stored = null;
    findOneAndUpdate.mockReset();
    vi.clearAllMocks();
  });

  it('refuses a list with an invalid address and names the entry', async () => {
    await expect(
      runHandler('ImageModerationReviewerEmails', ['reviewer@example.com', 'not-an-email'])
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('not-an-email'),
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('stores a valid list trimmed, lowercased and deduped', async () => {
    stageWriteResult('ImageModerationReviewerEmails', ['reviewer@example.com']);
    await runHandler('ImageModerationReviewerEmails', [' Reviewer@Example.com', 'reviewer@example.com']);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'ImageModerationReviewerEmails' },
      { $set: { settingValue: ['reviewer@example.com'] } },
      expect.anything()
    );
  });

  it('refuses a value that is not a list', async () => {
    await expect(runHandler('ImageModerationReviewerEmails', 'reviewer@example.com')).rejects.toThrow();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('stores an empty list when every address is removed', async () => {
    stageWriteResult('ImageModerationReviewerEmails', []);
    await runHandler('ImageModerationReviewerEmails', []);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'ImageModerationReviewerEmails' },
      { $set: { settingValue: [] } },
      expect.anything()
    );
  });
});

describe('settings/update blocked email domain list', () => {
  beforeEach(() => {
    stored = null;
    findOneAndUpdate.mockReset();
    vi.clearAllMocks();
  });

  it('refuses a list with an invalid domain and names the entry', async () => {
    await expect(runHandler('blockedEmailDomains', ['kashre.com', 'not a domain'])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('not a domain'),
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it.each([['co.uk'], ['github.io']])('refuses the bare public suffix %s', async suffix => {
    await expect(runHandler('blockedEmailDomains', ['kashre.com', suffix])).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining(JSON.stringify(suffix)),
    });
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('accepts a subdomain under a public suffix', async () => {
    stageWriteResult('blockedEmailDomains', ['burner.co.uk', 'np.kashre.com']);
    await runHandler('blockedEmailDomains', ['burner.co.uk', 'np.kashre.com']);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'blockedEmailDomains' },
      { $set: { settingValue: ['burner.co.uk', 'np.kashre.com'] } },
      expect.anything()
    );
  });

  it('stores a valid list normalized and deduped', async () => {
    stageWriteResult('blockedEmailDomains', ['kashre.com', 'xzcoot.com']);
    await runHandler('blockedEmailDomains', [' Kashre.com', '@kashre.com', '*.xzcoot.com']);
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      { settingName: 'blockedEmailDomains' },
      { $set: { settingValue: ['kashre.com', 'xzcoot.com'] } },
      expect.anything()
    );
  });
});

describe('settings/update admin audit trail', () => {
  beforeEach(() => {
    order.length = 0;
    stored = null;
    findOneAndUpdate.mockReset();
    deleteOne.mockReset();
    recordAdminActionFromRequest.mockReset().mockResolvedValue(null);
  });

  it('records the before and after of an upsert', async () => {
    stored = { settingName: 'tagLineMain', settingValue: 'Old line' };
    stageWriteResult('tagLineMain', 'Welcome aboard');
    await runHandler('tagLineMain', 'Welcome aboard');

    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'settings.admin_settings.updated',
        target: { kind: 'settings', id: 'tagLineMain', displayName: 'tagLineMain' },
        changes: [{ field: 'tagLineMain', before: 'Old line', after: 'Welcome aboard' }],
      })
    );
  });

  it('writes and records an upsert inside one transaction', async () => {
    stored = { settingName: 'tagLineMain', settingValue: 'Old line' };
    stageWriteResult('tagLineMain', 'Welcome aboard');
    await runHandler('tagLineMain', 'Welcome aboard');

    expect(order).toEqual(['tx:start', 'findOneAndUpdate', 'record', 'tx:end']);
  });

  it('deletes and records a clear inside one transaction', async () => {
    stored = { settingName: 'forcedRetrievalMinSimilarityPct', settingValue: 60 };
    await runHandler('forcedRetrievalMinSimilarityPct', '');

    expect(order).toEqual(['tx:start', 'deleteOne', 'record', 'tx:end']);
  });

  it('records a null before when the setting was never stored', async () => {
    stageWriteResult('tagLineMain', 'Welcome aboard');
    await runHandler('tagLineMain', 'Welcome aboard');

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ changes: [{ field: 'tagLineMain', before: null, after: 'Welcome aboard' }] })
    );
  });

  it('records a clear that deletes the row with the old value and a null after', async () => {
    stored = { settingName: 'forcedRetrievalMinSimilarityPct', settingValue: 60 };
    await runHandler('forcedRetrievalMinSimilarityPct', '');

    expect(deleteOne).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledTimes(1);
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'settings.admin_settings.updated',
        summary: 'cleared forcedRetrievalMinSimilarityPct',
        changes: [{ field: 'forcedRetrievalMinSimilarityPct', before: 60, after: null }],
      })
    );
  });

  it('never records the value of a sensitive setting, before or after', async () => {
    stored = { settingName: 'anthropicDemoKey', settingValue: 'enc:sk-ant-api03-original' };
    stageWriteResult('anthropicDemoKey', 'enc:sk-ant-api03-brandnew');
    await runHandler('anthropicDemoKey', 'sk-ant-api03-brandnew');

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: [{ field: 'anthropicDemoKey', before: '[REDACTED]', after: '[REDACTED]' }],
      })
    );
    const serialized = JSON.stringify(recordAdminActionFromRequest.mock.calls.map(([, entry]) => entry));
    expect(serialized).not.toContain('sk-ant-api03');
  });

  it('records only the changed sub-keys of an object setting, and the writer redacts secret ones', async () => {
    stored = {
      settingName: 'sreAgentConfig',
      settingValue: { enabled: true, label: 'a', webhookSecret: 'enc:old', callbackToken: 'enc:old' },
    };
    const next = { enabled: true, label: 'b', webhookSecret: 'enc:new', callbackToken: 'enc:new' };
    stageWriteResult('sreAgentConfig', next);
    await runHandler('sreAgentConfig', next);

    const { changes } = recordAdminActionFromRequest.mock.calls[0][1] as {
      changes: { field: string; before: unknown; after: unknown }[];
    };
    expect(changes.map(change => change.field).sort()).toEqual([
      'sreAgentConfig.callbackToken',
      'sreAgentConfig.label',
      'sreAgentConfig.webhookSecret',
    ]);
    expect(changes.find(change => change.field === 'sreAgentConfig.label')).toEqual({
      field: 'sreAgentConfig.label',
      before: 'a',
      after: 'b',
    });
    const written = JSON.stringify(changes.map(adminAuditService.redactChange));
    expect(written).not.toContain('enc:');
  });

  it('falls back to one whole-value change when no sub-key differs', async () => {
    stored = { settingName: 'sreAgentConfig', settingValue: { enabled: true } };
    stageWriteResult('sreAgentConfig', { enabled: true });
    await runHandler('sreAgentConfig', { enabled: true });

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: [{ field: 'sreAgentConfig', before: { enabled: true }, after: { enabled: true } }],
      })
    );
  });

  it('records a deliberate clear of a sensitive setting as redacted too', async () => {
    stored = { settingName: 'anthropicDemoKey', settingValue: 'enc:sk-ant-api03-original' };
    stageWriteResult('anthropicDemoKey', '');
    await runHandler('anthropicDemoKey', '', { confirmClear: true });

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        changes: [{ field: 'anthropicDemoKey', before: '[REDACTED]', after: '[REDACTED]' }],
      })
    );
  });

  it('records nothing when a mask is written back and the stored secret is kept', async () => {
    stored = { settingName: 'anthropicDemoKey', settingValue: 'enc:sk-ant-api03-original' };
    await runHandler('anthropicDemoKey', `${SENSITIVE_SETTING_MASK}inal`);

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('fails the write when the audit entry cannot be written', async () => {
    stageWriteResult('tagLineMain', 'Welcome aboard');
    recordAdminActionFromRequest.mockRejectedValue(new Error('audit down'));

    await expect(runHandler('tagLineMain', 'Welcome aboard')).rejects.toThrow('audit down');
  });
});
