import { describe, expect, it } from 'vitest';
import { CHAT_MODELS } from '../models';
import { ADMIN_AI_FEATURE_ENGINE, ADMIN_AI_FEATURES, confidenceBand } from './adminAi';
import { API_SERVICE_GROUPS, AdminAiConfigSchema, SettingKeySchema, settingsMap } from './settings';

describe('AdminAiConfigSchema', () => {
  it('defaults to spending nothing', () => {
    const config = AdminAiConfigSchema.parse({});

    expect(config.enabled).toBe(false);
    expect(config.monthlyCapUsd).toBe(0);
    expect(Object.keys(config.features).sort()).toEqual([...ADMIN_AI_FEATURES].sort());
    for (const feature of ADMIN_AI_FEATURES) {
      expect(config.features[feature]).toEqual({
        mode: 'off',
        model: null,
        escalationModel: null,
        confidenceThreshold: 0.8,
        dailyBudgetUsd: 0,
        maxCallsPerDay: 0,
      });
    }
  });

  it('fills the rest of a feature from defaults when one field is set', () => {
    const config = AdminAiConfigSchema.parse({ features: { dlqTriage: { mode: 'shadow' } } });

    expect(config.features.dlqTriage.mode).toBe('shadow');
    expect(config.features.dlqTriage.dailyBudgetUsd).toBe(0);
    expect(config.features.morningBrief.mode).toBe('off');
  });

  it.each([
    ['an unknown mode', { features: { domainHold: { mode: 'auto' } } }],
    ['a negative daily budget', { features: { domainHold: { dailyBudgetUsd: -1 } } }],
    ['a threshold above 1', { features: { feedbackTriage: { confidenceThreshold: 1.5 } } }],
    ['a negative monthly cap', { monthlyCapUsd: -5 }],
    ['a non-catalog model on a decision feature', { features: { abuseAssessment: { model: 'free-text-model' } } }],
  ])('rejects %s', (_label, value) => {
    expect(AdminAiConfigSchema.safeParse(value).success).toBe(false);
  });

  it('takes a chat model on a text feature and rejects an unknown one', () => {
    expect(AdminAiConfigSchema.safeParse({ features: { morningBrief: { model: 'any-model-id' } } }).success).toBe(
      false
    );
    const config = AdminAiConfigSchema.parse({ features: { morningBrief: { model: CHAT_MODELS[0] } } });
    expect(config.features.morningBrief.model).toBe(CHAT_MODELS[0]);
  });

  it('strips an unknown feature key', () => {
    const config = AdminAiConfigSchema.parse({ features: { unknownFeature: { mode: 'act' } } });
    expect(config.features).not.toHaveProperty('unknownFeature');
  });

  it('is registered in the key enum, the settings map and its admin group', () => {
    expect(SettingKeySchema.options).toContain('adminAiConfig');
    expect(settingsMap.adminAiConfig.defaultValue).toEqual(AdminAiConfigSchema.parse({}));
    expect(settingsMap.adminAiConfig.group).toBe(API_SERVICE_GROUPS.ADMIN_AI.id);
    expect(API_SERVICE_GROUPS.ADMIN_AI.settings.map(s => s.key)).toContain('adminAiConfig');
  });

  it('names an engine for every feature', () => {
    expect(Object.keys(ADMIN_AI_FEATURE_ENGINE).sort()).toEqual([...ADMIN_AI_FEATURES].sort());
  });
});

describe('confidenceBand', () => {
  it.each([
    [0.95, 'high'],
    [0.8, 'high'],
    [0.79, 'medium'],
    [0.5, 'medium'],
    [0.49, 'low'],
    [0, 'low'],
    [Number.NaN, 'low'],
    [1.2, 'low'],
    [-0.1, 'low'],
  ] as const)('bands %s as %s', (probability, band) => {
    expect(confidenceBand(probability)).toBe(band);
  });
});
