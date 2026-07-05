import { describe, it, expect } from 'vitest';
import {
  settingsMap,
  publicSafeSettingKeys,
  redactSettingSecrets,
  buildPublicSettingsProjection,
  experimentalFeatureSettingKeys,
  experimentalNonGroupSettingKeys,
  API_SERVICE_GROUPS,
  type AdminSettingDoc,
} from './settings';
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
      for (const secret of ['openaiDemoKey', 'anthropicDemoKey', 'xaiApiKey', 'geminiDemoKey', 'voyageApiKey']) {
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
