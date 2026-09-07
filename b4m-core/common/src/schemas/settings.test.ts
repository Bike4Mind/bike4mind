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
  ABSTENTION_PROMPT,
} from './settings';
import {
  DEFAULT_PASSAGE_TOKEN_TARGET,
  MIN_PASSAGE_TOKEN_TARGET,
  OVERSIZED_PASSAGE_TOKEN_THRESHOLD,
} from '../constants/chunking';
import {
  LAKE_ACCESS_AUDIT_RETENTION_DEFAULT_DAYS,
  LAKE_ACCESS_AUDIT_RETENTION_FLOOR_DAYS,
} from '../constants/lakeAccessAudit';
import { FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT } from '../constants/forcedRetrieval';
import {
  KB_SEARCH_DEFAULT_RESULTS_DEFAULT,
  KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT,
  KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT,
} from '../constants/knowledgeBaseSearch';
import { SRE_SECRET_PLACEHOLDER } from '../types/entities/SreTypes';
import { SettingScopeLevel } from '../types/entities/ScopedSettingTypes';

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

    it('masks a settingName absent from settingsMap instead of returning it in cleartext (fail closed)', () => {
      const secret = 'sk-live-orphaned-credential-tail';
      const redacted = redactSettingSecrets({ settingName: 'someRemovedOrRenamedKey', settingValue: secret });
      expect(redacted.settingValue).not.toBe(secret);
      expect(redacted.settingValue).toBe(`${SENSITIVE_SETTING_MASK}tail`);
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

    it('masks a settingName absent from settingsMap instead of broadcasting it in cleartext (fail closed)', () => {
      const redacted = redactSettingSecretsForBroadcast({
        settingName: 'someRemovedOrRenamedKey',
        settingValue: 'a'.repeat(32) + ':' + 'b'.repeat(32) + ':deadbeef',
      });
      expect(redacted.settingValue).toBe(SENSITIVE_SETTING_MASK);
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

  it('cannot be set above the under-chunked detection threshold (#1804)', () => {
    // Above it, a file re-chunks to a size that is correct per policy and STILL trips detection
    // (findUnderChunkedFabFileIds matches tokenCount $gt threshold), so "Rebuild passages" never
    // converges and each click destructively re-chunks and re-embeds the same files.
    expect(settingsMap.DefaultChunkSize.max).toBe(OVERSIZED_PASSAGE_TOKEN_THRESHOLD);
    expect(() => settingsMap.DefaultChunkSize.schema.parse(OVERSIZED_PASSAGE_TOKEN_THRESHOLD + 1)).toThrow();
    // Detection is $gt, so the threshold ITSELF is convergent and must stay accepted.
    expect(settingsMap.DefaultChunkSize.schema.parse(OVERSIZED_PASSAGE_TOKEN_THRESHOLD)).toBe(
      OVERSIZED_PASSAGE_TOKEN_THRESHOLD
    );
  });

  it('CLAMPS an already-stored oversized value, so the bound is retroactive (#1804)', () => {
    // `max` only rejects new writes. A value saved before this shipped would otherwise keep
    // resolving at its stored size and keep the badge non-convergent, which is the actual defect.
    const clamp = settingsMap.DefaultChunkSize.scope?.clamp;
    expect(clamp).toBeDefined();
    expect(clamp!(8192)).toBe(OVERSIZED_PASSAGE_TOKEN_THRESHOLD);
    expect(clamp!(2048)).toBe(OVERSIZED_PASSAGE_TOKEN_THRESHOLD);
    // Still clamps up at the floor, and leaves an in-range value alone.
    expect(clamp!(1)).toBe(MIN_PASSAGE_TOKEN_TARGET);
    expect(clamp!(DEFAULT_PASSAGE_TOKEN_TARGET)).toBe(DEFAULT_PASSAGE_TOKEN_TARGET);
  });
});

describe('forcedRetrievalCharBudget agrees with the forced-retrieval fallback (#1831)', () => {
  // Same drift class as DefaultChunkSize above: before this setting existed, the char budget was a
  // hand-copied literal (12000) in ChatCompletionFeatures.ts. Both now import
  // FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT from the same constants module, so this pins that the
  // setting's default cannot silently diverge from the coded fallback a settings outage returns to.
  it('defaults to the shared constant, not a hand-copied literal', () => {
    expect(settingsMap.forcedRetrievalCharBudget.defaultValue).toBe(FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT);
  });

  it('is platform-only: declares no scope, unlike its sibling dataLakeSearchMaxFiles/MaxChunks', () => {
    // Deliberate, not an oversight - see the setting's own description. This path reads the setting
    // directly rather than through the scoped-settings resolver, so a settableAt block here would be
    // inert at best and could arm the resolver's fail-loud owner check at worst.
    expect(settingsMap.forcedRetrievalCharBudget.scope).toBeUndefined();
  });

  it('prefaults to the shared constant rather than makeNumberSetting fallback 0', () => {
    expect(settingsMap.forcedRetrievalCharBudget.schema.parse(undefined)).toBe(FORCED_RETRIEVAL_CHAR_BUDGET_DEFAULT);
  });

  it('rejects a value below the declared floor at write time', () => {
    // Same pattern as DefaultChunkSize above: the write path (settings/update.ts) calls
    // schema.parse and throws on failure, so this is what actually stops an admin from saving an
    // unusably small budget - positiveIntOr's own floor is defense-in-depth, not the real gate.
    expect(settingsMap.forcedRetrievalCharBudget.min).toBe(1_000);
    expect(() => settingsMap.forcedRetrievalCharBudget.schema.parse(999)).toThrow();
    expect(settingsMap.forcedRetrievalCharBudget.schema.parse(1_000)).toBe(1_000);
  });

  it('rejects a value above the declared ceiling at write time (#1860 P2-1)', () => {
    // Without this, a fat-fingered extra zero (24000 -> 240000) passed write-time validation
    // cleanly and silently shed conversation history via ChatCompletionProcess's overflow-recovery
    // loop before eventually hard-erroring - the retrieval block itself is never shed, only prior
    // turns are.
    expect(settingsMap.forcedRetrievalCharBudget.max).toBe(100_000);
    expect(() => settingsMap.forcedRetrievalCharBudget.schema.parse(100_001)).toThrow();
    expect(settingsMap.forcedRetrievalCharBudget.schema.parse(100_000)).toBe(100_000);
  });
});

describe('kbSearchDefaultResults agrees with the search_knowledge_base tool fallback (#1831)', () => {
  // Same drift class as forcedRetrievalCharBudget above: before this setting existed,
  // KB_SEARCH_DEFAULT_RESULTS was a hand-copied literal (5) local to the tool's own file. Both now
  // import KB_SEARCH_DEFAULT_RESULTS_DEFAULT from the same constants module, so this pins that the
  // setting's default cannot silently diverge from the coded fallback a settings outage returns to.
  it('defaults to the shared constant, not a hand-copied literal', () => {
    expect(settingsMap.kbSearchDefaultResults.defaultValue).toBe(KB_SEARCH_DEFAULT_RESULTS_DEFAULT);
  });

  it('is settable at the org/owner (caller) altitude, but deliberately not at Lake (#1955)', () => {
    // A knowledge-base search spans a mixed multi-lake corpus plus the caller's own/shared files -
    // there is no single lake for a Lake rung to key on, unlike dataLakeSearchMaxFiles/MaxChunks
    // (which scan one lake at a time and do declare Lake). Pinned so adding Lake later is a
    // deliberate decision rather than silent drift.
    expect(settingsMap.kbSearchDefaultResults.scope?.settableAt).toEqual([
      SettingScopeLevel.Organization,
      SettingScopeLevel.Owner,
    ]);
  });

  it('prefaults to the shared constant rather than makeNumberSetting fallback 0', () => {
    expect(settingsMap.kbSearchDefaultResults.schema.parse(undefined)).toBe(KB_SEARCH_DEFAULT_RESULTS_DEFAULT);
  });

  it('rejects a value below the declared floor at write time', () => {
    expect(settingsMap.kbSearchDefaultResults.min).toBe(1);
    expect(() => settingsMap.kbSearchDefaultResults.schema.parse(0)).toThrow();
    expect(settingsMap.kbSearchDefaultResults.schema.parse(1)).toBe(1);
  });

  it('rejects a value above the tool ceiling at write time', () => {
    // Without this, an admin could store a default above KB_SEARCH_MAX_RESULTS (10) that the tool
    // would then clamp down on every call, making the stored value silently misleading.
    expect(settingsMap.kbSearchDefaultResults.max).toBe(10);
    expect(() => settingsMap.kbSearchDefaultResults.schema.parse(11)).toThrow();
    expect(settingsMap.kbSearchDefaultResults.schema.parse(10)).toBe(10);
  });
});

describe('kbSearchResultTokenBudget (#1955)', () => {
  it('defaults to the shared off-sentinel constant, not a hand-copied literal', () => {
    expect(settingsMap.kbSearchResultTokenBudget.defaultValue).toBe(KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT);
    // The constant IS 0 today, so the assertion above alone would pass even if someone hand-wrote
    // a literal 0 instead of importing the constant. Pin the value directly too, with the intent
    // spelled out: 0 is a deliberate "no budget" sentinel, not "forgot to set a default".
    expect(settingsMap.kbSearchResultTokenBudget.defaultValue).toBe(0);
  });

  it('is settable at the org/owner (caller) altitude, not Lake', () => {
    expect(settingsMap.kbSearchResultTokenBudget.scope?.settableAt).toEqual([
      SettingScopeLevel.Organization,
      SettingScopeLevel.Owner,
    ]);
  });

  it('prefaults to the shared constant rather than makeNumberSetting fallback', () => {
    expect(settingsMap.kbSearchResultTokenBudget.schema.parse(undefined)).toBe(KB_SEARCH_RESULT_TOKEN_BUDGET_DEFAULT);
  });

  it('accepts 0 (the off sentinel) at write time without throwing', () => {
    expect(settingsMap.kbSearchResultTokenBudget.min).toBe(0);
    expect(settingsMap.kbSearchResultTokenBudget.schema.parse(0)).toBe(0);
  });

  it('rejects a negative value and enforces the declared ceiling at write time', () => {
    expect(() => settingsMap.kbSearchResultTokenBudget.schema.parse(-1)).toThrow();
    expect(settingsMap.kbSearchResultTokenBudget.max).toBe(20_000);
    expect(() => settingsMap.kbSearchResultTokenBudget.schema.parse(20_001)).toThrow();
    expect(settingsMap.kbSearchResultTokenBudget.schema.parse(20_000)).toBe(20_000);
  });
});

describe('kbSearchMinRelevancePct (#1955)', () => {
  it('defaults to the shared off-sentinel constant, not a hand-copied literal', () => {
    expect(settingsMap.kbSearchMinRelevancePct.defaultValue).toBe(KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT);
    // Same vacuous-drift-guard caveat as the token budget above: the constant is 0 today, so pin
    // the literal too and say why - 0 matches today's hardcoded minScore: 0, not an oversight.
    expect(settingsMap.kbSearchMinRelevancePct.defaultValue).toBe(0);
  });

  it('is settable at the org/owner (caller) altitude, not Lake', () => {
    expect(settingsMap.kbSearchMinRelevancePct.scope?.settableAt).toEqual([
      SettingScopeLevel.Organization,
      SettingScopeLevel.Owner,
    ]);
  });

  it('prefaults to the shared constant rather than makeNumberSetting fallback', () => {
    expect(settingsMap.kbSearchMinRelevancePct.schema.parse(undefined)).toBe(KB_SEARCH_MIN_RELEVANCE_PCT_DEFAULT);
  });

  it('accepts 0 and 100 at write time; rejects outside that range', () => {
    expect(settingsMap.kbSearchMinRelevancePct.min).toBe(0);
    expect(settingsMap.kbSearchMinRelevancePct.max).toBe(100);
    expect(settingsMap.kbSearchMinRelevancePct.schema.parse(0)).toBe(0);
    expect(settingsMap.kbSearchMinRelevancePct.schema.parse(100)).toBe(100);
    expect(() => settingsMap.kbSearchMinRelevancePct.schema.parse(-1)).toThrow();
    expect(() => settingsMap.kbSearchMinRelevancePct.schema.parse(101)).toThrow();
  });
});

describe('EMBEDDING settings group registration (#1955)', () => {
  it('lists kbSearchDefaultResults, kbSearchResultTokenBudget and kbSearchMinRelevancePct with unique order values', () => {
    const keys = ['kbSearchDefaultResults', 'kbSearchResultTokenBudget', 'kbSearchMinRelevancePct'];
    const entries = API_SERVICE_GROUPS.EMBEDDING.settings.filter(s => keys.includes(s.key));
    expect(entries.map(s => s.key).sort()).toEqual([...keys].sort());
    expect(new Set(entries.map(s => s.order)).size).toBe(entries.length);
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

describe('AbstentionPrompt default carries the anti-invention licence', () => {
  // The always-on backstop is the ONLY anti-invention text on a normal turn that answers WITHOUT
  // searching the knowledge base. (A promptMode session strips it like any authored prompt, so that
  // surface is an uncovered gap by design - not something this backstop routes around.) Guard that
  // its default still both licenses abstention AND bars volunteering a specific unsourced fact. The
  // grounded-surface half ships two tests; without this, blanking this clause would pass unnoticed.
  it('licenses saying "not enough to answer" instead of inventing', () => {
    expect(ABSTENTION_PROMPT).toContain('I do not have enough to answer that');
    expect(ABSTENTION_PROMPT).toMatch(/never invent facts/i);
  });

  it('bars stating - or citing a source for - a specific customer/competitor/deal/figure', () => {
    for (const noun of ['customer', 'competitor', 'deal', 'figure']) {
      expect(ABSTENTION_PROMPT.toLowerCase()).toContain(noun);
    }
    expect(ABSTENTION_PROMPT).toMatch(/cite a source/i);
  });

  it('ships as the AbstentionPrompt setting default (no drift between const and setting)', () => {
    expect(settingsMap.AbstentionPrompt.defaultValue).toBe(ABSTENTION_PROMPT);
  });
});

describe('bflApiKey spells the vendor the way the rest of the app does', () => {
  // The vendor's own name is three words, and two client surfaces already render it that way
  // (ApiKeysSection.tsx's PROVIDER_LABELS, ModelSelection.tsx's FLUX section header). This admin
  // label is a third independent hardcoding of the same string with nothing forcing it to agree,
  // so pin the spelling here rather than let it drift back.
  for (const field of ['name', 'description'] as const) {
    it(`${field} says "Black Forest Labs", not "BlackForest"`, () => {
      expect(settingsMap.bflApiKey[field]).toContain('Black Forest Labs');
      expect(settingsMap.bflApiKey[field]).not.toContain('BlackForest');
    });
  }
});
