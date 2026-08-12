import { describe, it, expect } from 'vitest';
import {
  settingsMap,
  publicSafeSettingKeys,
  redactSettingSecrets,
  redactSettingSecretsForBroadcast,
  buildPublicSettingsProjection,
  experimentalFeatureSettingKeys,
  experimentalNonGroupSettingKeys,
  API_SERVICE_GROUPS,
  SENSITIVE_SETTING_MASK,
  maskSensitiveSettingValue,
  isMaskedSensitiveSettingValue,
  type AdminSettingDoc,
} from './settings';
import { DEFAULT_PASSAGE_TOKEN_TARGET, MIN_PASSAGE_TOKEN_TARGET } from '../constants/chunking';
import {
  LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS,
  LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS,
} from '../constants/lakeAccessAudit';
import { SRE_SECRET_PLACEHOLDER } from '../types/entities/SreTypes';

describe('makeObjectSetting JSON preprocess', () => {
  // Test using contextTelemetryAlerts as a representative object setting
  const schema = settingsMap.contextTelemetryAlerts.schema;

  describe('JSON string parsing', () => {
    it('should parse valid JSON string into object', () => {
      const jsonString = JSON.stringify({ enabled: true, alertThreshold: 50 });
      const result = schema.safeParse(jsonString);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.alertThreshold).toBe(50);
      }
    });

    it('should handle complex nested JSON strings', () => {
      const jsonString = JSON.stringify({
        enabled: true,
        autoCreateIssues: true,
        alertThreshold: 30,
        criticalThreshold: 50,
        temperature: 0.5,
        maxTokens: 1500,
        timeoutMs: 90000,
        dedupWindowMinutes: 10,
        slackWorkspaceId: 'workspace-123',
        slackChannelId: 'C123456',
        githubOwner: 'TestOrg',
        githubRepo: 'test-repo',
        modelId: 'gpt-4',
      });
      const result = schema.safeParse(jsonString);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.slackWorkspaceId).toBe('workspace-123');
        expect(result.data.githubOwner).toBe('TestOrg');
      }
    });

    it('should fail gracefully on invalid JSON string', () => {
      const invalidJson = '{invalid json}';
      const result = schema.safeParse(invalidJson);

      // Should fail validation (invalid JSON passed to schema as-is)
      expect(result.success).toBe(false);
    });

    it('should fail on malformed JSON string', () => {
      const malformedJson = '{"enabled": true,}'; // trailing comma
      const result = schema.safeParse(malformedJson);

      expect(result.success).toBe(false);
    });
  });

  describe('object pass-through', () => {
    it('should accept object directly without double-parsing', () => {
      const obj = { enabled: true, alertThreshold: 40 };
      const result = schema.safeParse(obj);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.alertThreshold).toBe(40);
      }
    });

    it('should apply defaults for missing fields', () => {
      const result = schema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.autoCreateIssues).toBe(false);
        expect(typeof result.data.alertThreshold).toBe('number');
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty JSON object string', () => {
      const result = schema.safeParse('{}');

      expect(result.success).toBe(true);
      if (result.success) {
        // Should have defaults applied
        expect(result.data.enabled).toBe(false);
      }
    });

    it('should reject null', () => {
      const result = schema.safeParse(null);
      expect(result.success).toBe(false);
    });

    it('should reject undefined', () => {
      const result = schema.safeParse(undefined);
      expect(result.success).toBe(false);
    });

    it('should reject non-object primitives', () => {
      expect(schema.safeParse(123).success).toBe(false);
      expect(schema.safeParse(true).success).toBe(false);
      expect(schema.safeParse([]).success).toBe(false);
    });
  });
});

describe('other object settings use makeObjectSetting', () => {
  // Verify all object settings benefit from the JSON preprocess fix
  const objectSettings = [
    'contextTelemetryAlerts',
    'logoSettings',
    'RapidReplySettings',
    'whatsNewConfig',
    'whatsNewSyncConfig',
  ] as const;

  it.each(objectSettings)('%s should parse JSON strings', settingKey => {
    const schema = settingsMap[settingKey].schema;
    // All object settings should handle JSON strings
    const result = schema.safeParse('{}');
    expect(result.success).toBe(true);
  });
});

describe('public settings projection (M2.5 security boundary)', () => {
  describe('publicSafeSettingKeys', () => {
    it('returns only keys explicitly tagged publicSafe', () => {
      const keys = publicSafeSettingKeys();
      // Seeded allowlist - startup-critical, non-sensitive.
      expect(keys).toContain('enforceMFA');
      expect(keys).toContain('DefaultAPIModel');
      // Every returned key must actually carry the flag.
      for (const k of keys) {
        expect((settingsMap as Record<string, { publicSafe?: boolean }>)[k].publicSafe).toBe(true);
      }
    });

    it('NEVER includes a setting that is also marked isSensitive (fail-closed invariant)', () => {
      const sensitiveAndPublic = (
        Object.values(settingsMap) as Array<{ key: string; isSensitive?: boolean; publicSafe?: boolean }>
      ).filter(s => s.publicSafe === true && s.isSensitive === true);
      expect(sensitiveAndPublic).toEqual([]);
    });

    it('does not expose any known secret-bearing API key settings', () => {
      const keys = publicSafeSettingKeys();
      for (const secret of [
        'openaiDemoKey',
        'anthropicDemoKey',
        'xaiApiKey',
        'moonshotApiKey',
        'geminiDemoKey',
        'voyageApiKey',
      ]) {
        expect(keys).not.toContain(secret);
      }
    });

    it('does not expose operational config (sreAgentConfig is !isSensitive but must stay private)', () => {
      expect(publicSafeSettingKeys()).not.toContain('sreAgentConfig');
    });
  });

  describe('buildPublicSettingsProjection', () => {
    // Inputs carry Mongo/soft-delete metadata to prove it is stripped from the public file.
    const input: AdminSettingDoc[] = [
      {
        settingName: 'enforceMFA',
        settingValue: 'true',
        _id: 'abc123',
        __v: 0,
        createdAt: 'x',
        updatedAt: 'y',
        deletedAt: null,
      },
      { settingName: 'DefaultAPIModel', settingValue: 'gpt-5', _id: 'def456', __v: 2 },
      { settingName: 'openaiDemoKey', settingValue: 'sk-SHOULD-NEVER-LEAK' },
      {
        settingName: 'sreAgentConfig',
        settingValue: {
          repos: [{ owner: 'acme', repo: 'secret-repo', webhookSecret: 'hunter2', callbackToken: 'tok' }],
        },
      },
      { settingName: 'someUnknownSetting', settingValue: 'x' },
    ];

    it('includes only publicSafe keys', () => {
      const out = buildPublicSettingsProjection(input);
      const names = out.map(s => s.settingName).sort();
      expect(names).toEqual(['DefaultAPIModel', 'enforceMFA']);
    });

    it('never emits a sensitive secret value even if present in the input', () => {
      const serialized = JSON.stringify(buildPublicSettingsProjection(input));
      expect(serialized).not.toContain('sk-SHOULD-NEVER-LEAK');
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('secret-repo');
    });

    it('slims to exactly {settingName, settingValue} — no Mongo/soft-delete metadata leaks', () => {
      const out = buildPublicSettingsProjection(input);
      for (const setting of out) {
        expect(Object.keys(setting).sort()).toEqual(['settingName', 'settingValue']);
      }
      const serialized = JSON.stringify(out);
      for (const meta of ['_id', '__v', 'createdAt', 'updatedAt', 'deletedAt', 'abc123', 'def456']) {
        expect(serialized).not.toContain(meta);
      }
    });
  });

  describe('redactSettingSecrets', () => {
    it('masks sreAgentConfig per-repo secrets', () => {
      const redacted = redactSettingSecrets({
        settingName: 'sreAgentConfig',
        settingValue: { repos: [{ owner: 'a', repo: 'b', webhookSecret: 'hunter2', callbackToken: 'tok' }] },
      });
      const repo = (redacted.settingValue as { repos: Array<{ webhookSecret: string; callbackToken: string }> })
        .repos[0];
      expect(repo.webhookSecret).toBe(SRE_SECRET_PLACEHOLDER);
      expect(repo.callbackToken).toBe(SRE_SECRET_PLACEHOLDER);
    });

    it('passes non-sre settings through untouched', () => {
      const setting: AdminSettingDoc = { settingName: 'enforceMFA', settingValue: 'true' };
      expect(redactSettingSecrets(setting)).toEqual(setting);
    });

    it('masks EVERY isSensitive setting, not a hand-listed subset', () => {
      const sensitiveKeys = (Object.values(settingsMap) as Array<{ key: string; isSensitive?: boolean }>)
        .filter(s => s.isSensitive === true)
        .map(s => s.key);
      expect(sensitiveKeys.length).toBeGreaterThan(0);

      for (const key of sensitiveKeys) {
        const secret = `sk-live-${key}-tail`;
        const redacted = redactSettingSecrets({ settingName: key, settingValue: secret });
        expect(redacted.settingValue).not.toBe(secret);
        expect(redacted.settingValue).toBe(`${SENSITIVE_SETTING_MASK}tail`);
      }
    });

    it('leaves an unset sensitive setting empty rather than showing a mask', () => {
      expect(redactSettingSecrets({ settingName: 'anthropicDemoKey', settingValue: '' }).settingValue).toBe('');
    });

    it('every isSensitive setting is a plain free-text string setting', () => {
      // The whole mask/preserve protocol assumes a string. A sensitive setting that is a
      // number, boolean, object, or a string with `options` breaks three ways at once: it
      // masks to '' and renders as unset, it never routes through the input's focus/blur
      // edit tracking, and isMaskedSensitiveSettingValue('') is false so the preserve branch
      // can never fire - leaving it one Save away from being wiped. Fail here instead.
      const offenders = (
        Object.values(settingsMap) as Array<{
          key: string;
          isSensitive?: boolean;
          type?: string;
          options?: unknown[];
        }>
      )
        .filter(s => s.isSensitive === true && (s.type !== 'string' || s.options !== undefined))
        .map(s => s.key);

      expect(offenders, `isSensitive settings that are not plain string inputs: ${offenders.join(', ')}`).toEqual([]);
    });
  });

  describe('redactSettingSecretsForBroadcast', () => {
    it('emits a bare mask with NO tail for a sensitive setting (browser cannot decrypt ciphertext)', () => {
      // The WS fanout carries the raw stored document - ciphertext post-migration. Masking its
      // tail would surface a wrong "last 4"; a bare mask cannot be mis-verified.
      const ciphertext = 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':deadbeef';
      const redacted = redactSettingSecretsForBroadcast({ settingName: 'anthropicDemoKey', settingValue: ciphertext });
      expect(redacted.settingValue).toBe(SENSITIVE_SETTING_MASK);
      // Never the ciphertext tail (the whole point of the fix).
      expect(redacted.settingValue).not.toBe(`${SENSITIVE_SETTING_MASK}beef`);
    });

    it('leaves an unset sensitive setting empty', () => {
      expect(redactSettingSecretsForBroadcast({ settingName: 'anthropicDemoKey', settingValue: '' }).settingValue).toBe(
        ''
      );
    });

    it('still masks sreAgentConfig per-repo secrets (delegates to redactSettingSecrets)', () => {
      const redacted = redactSettingSecretsForBroadcast({
        settingName: 'sreAgentConfig',
        settingValue: { repos: [{ owner: 'a', repo: 'b', webhookSecret: 'hunter2', callbackToken: 'tok' }] },
      });
      const repo = (redacted.settingValue as { repos: Array<{ webhookSecret: string; callbackToken: string }> })
        .repos[0];
      expect(repo.webhookSecret).toBe(SRE_SECRET_PLACEHOLDER);
      expect(repo.callbackToken).toBe(SRE_SECRET_PLACEHOLDER);
    });

    it('passes a non-sensitive setting through untouched', () => {
      const setting: AdminSettingDoc = { settingName: 'enforceMFA', settingValue: 'true' };
      expect(redactSettingSecretsForBroadcast(setting)).toEqual(setting);
    });
  });
});

describe('sensitive setting masking', () => {
  it('pins the literal mask, because its exact shape is a wire contract', () => {
    // Every other assertion is written relative to the constant, so lengthening or changing
    // it would silently turn every stale browser tab's write-back into a literal overwrite
    // of a live credential. Pin the literal so that change has to be deliberate.
    expect(SENSITIVE_SETTING_MASK).toBe('********');
  });

  it('treats the shorter SystemSecrets mask as a placeholder too', () => {
    // system-secrets/index.ts masks with FOUR asterisks. Both screens can show the same
    // credential, so a value copied from there must never be stored literally.
    expect(isMaskedSensitiveSettingValue('****abcd')).toBe(true);
    expect(isMaskedSensitiveSettingValue('****')).toBe(true);
  });

  it('does not treat a short asterisk run as a placeholder', () => {
    expect(isMaskedSensitiveSettingValue('***')).toBe(false);
    expect(isMaskedSensitiveSettingValue('a****bcd')).toBe(false);
  });

  it('keeps only the last 4 characters', () => {
    expect(maskSensitiveSettingValue('sk-ant-api03-abcdefgh')).toBe(`${SENSITIVE_SETTING_MASK}efgh`);
  });

  it('reveals nothing at all for a short value', () => {
    // 4 of 8 chars would be half the secret, so the tail is dropped entirely.
    expect(maskSensitiveSettingValue('12345678')).toBe(SENSITIVE_SETTING_MASK);
  });

  it('maps a missing or non-string value to empty', () => {
    expect(maskSensitiveSettingValue('')).toBe('');
    expect(maskSensitiveSettingValue(undefined)).toBe('');
    expect(maskSensitiveSettingValue(null)).toBe('');
    expect(maskSensitiveSettingValue({ nested: 'x' })).toBe('');
  });

  it('recognizes its own output as a write-back placeholder', () => {
    expect(isMaskedSensitiveSettingValue(maskSensitiveSettingValue('sk-ant-api03-abcdefgh'))).toBe(true);
    expect(isMaskedSensitiveSettingValue(maskSensitiveSettingValue('12345678'))).toBe(true);
  });

  it('does not mistake a real secret for a placeholder', () => {
    expect(isMaskedSensitiveSettingValue('sk-ant-api03-abcdefgh')).toBe(false);
    expect(isMaskedSensitiveSettingValue('')).toBe(false);
    expect(isMaskedSensitiveSettingValue(undefined)).toBe(false);
  });
});

describe('experimentalFeatureSettingKeys (#9516)', () => {
  it('surfaces every EXPERIMENTAL-group setting (no silently-dead flag)', () => {
    const groupKeys = Object.values(settingsMap)
      .filter(s => s.group === API_SERVICE_GROUPS.EXPERIMENTAL.id)
      .map(s => s.key);

    expect(groupKeys.length).toBeGreaterThan(0);
    for (const key of groupKeys) {
      expect(experimentalFeatureSettingKeys).toContain(key);
    }
  });

  it('surfaces the #9506 motivating flag (EnableInertArtifactRender) via group membership', () => {
    // The original silently-dead flag. It lives in the EXPERIMENTAL group, so the
    // group rule must keep surfacing it without any explicit allowlist entry.
    expect(settingsMap.EnableInertArtifactRender.group).toBe(API_SERVICE_GROUPS.EXPERIMENTAL.id);
    expect(experimentalFeatureSettingKeys).toContain('EnableInertArtifactRender');
  });

  it('carries the documented non-group extras', () => {
    expect(experimentalNonGroupSettingKeys.length).toBeGreaterThan(0);
    for (const key of experimentalNonGroupSettingKeys) {
      expect(experimentalFeatureSettingKeys).toContain(key);
    }
  });

  it('contains only valid settingsMap keys', () => {
    for (const key of experimentalFeatureSettingKeys) {
      expect(settingsMap[key]).toBeDefined();
    }
  });

  it('has no duplicate keys', () => {
    expect(new Set(experimentalFeatureSettingKeys).size).toBe(experimentalFeatureSettingKeys.length);
  });
});

describe('DefaultChunkSize agrees with the chunker', () => {
  // The whole point of moving DEFAULT_PASSAGE_TOKEN_TARGET into this package: before it, the
  // number was hand-copied and had drifted four ways, and the admin setting is sent to
  // /api/files/chunk as an explicit chunkSize override - so a divergence here silently produces a
  // different chunk granularity through the UI than through /api/files/reprocess. Nothing tested
  // that invariant, which is exactly how it drifted the first time.
  it('defaults to the chunker passage target, not a hand-copied literal', () => {
    expect(settingsMap.DefaultChunkSize.defaultValue).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
  });

  it('cannot be set below the floor the chunker would silently clamp to', () => {
    // Without a min, an admin could save 10, the UI would report 10, and chunk.ts would quietly
    // use MIN_PASSAGE_TOKEN_TARGET instead - the same class of silent disagreement.
    expect(settingsMap.DefaultChunkSize.min).toBe(MIN_PASSAGE_TOKEN_TARGET);
    expect(() => settingsMap.DefaultChunkSize.schema.parse(MIN_PASSAGE_TOKEN_TARGET - 1)).toThrow();
    expect(settingsMap.DefaultChunkSize.schema.parse(MIN_PASSAGE_TOKEN_TARGET)).toBe(MIN_PASSAGE_TOKEN_TARGET);
  });

  it('prefaults to the chunker target rather than makeNumberSetting fallback 0', () => {
    // makeNumberSetting does `prefault(config.defaultValue ?? 0)`, so a broken import resolves to
    // 0 silently instead of throwing. Pin it.
    expect(settingsMap.DefaultChunkSize.schema.parse(undefined)).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
  });
});

describe('LakeAccessAuditRetentionDays cannot be configured below the floor', () => {
  // Same drift class as DefaultChunkSize: the floor is enforced in two places (this schema's
  // `min`, and the write path's unconditional clamp), and both must agree with the exported
  // constant or an admin could save a value the write path silently overrides without complaint.
  it('min matches the exported floor constant', () => {
    expect(settingsMap.LakeAccessAuditRetentionDays.min).toBe(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS);
  });

  it('rejects a save below the floor and accepts the floor itself', () => {
    expect(() =>
      settingsMap.LakeAccessAuditRetentionDays.schema.parse(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS - 1)
    ).toThrow();
    expect(settingsMap.LakeAccessAuditRetentionDays.schema.parse(LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS)).toBe(
      LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS
    );
  });

  it('prefaults to the default constant rather than makeNumberSetting fallback 0', () => {
    expect(settingsMap.LakeAccessAuditRetentionDays.schema.parse(undefined)).toBe(
      LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS
    );
  });
});
