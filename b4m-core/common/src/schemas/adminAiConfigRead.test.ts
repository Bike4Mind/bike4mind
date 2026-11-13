import { describe, expect, it } from 'vitest';
import { DECISION_MODEL_IDS } from '../decisions/catalog';
import { supportedChatModels } from '../models';
import { AdminAiConfigSchema, AdminAiStoredConfigSchema } from './settings';

const decisionModels = new Set<string>(DECISION_MODEL_IDS);
const legacyModel = supportedChatModels.options.find(model => !decisionModels.has(model));
if (!legacyModel) throw new Error('Expected a legacy chat-only model fixture');

const stored = {
  enabled: true,
  monthlyCapUsd: 33,
  features: {
    feedbackTriage: {
      mode: 'shadow',
      model: legacyModel,
      escalationModel: legacyModel,
      dailyBudgetUsd: 5,
      maxCallsPerDay: 8,
    },
    dlqTriage: { mode: 'shadow', model: legacyModel, dailyBudgetUsd: 2 },
  },
};
const expected = AdminAiConfigSchema.parse({
  ...stored,
  features: {
    ...stored.features,
    feedbackTriage: { ...stored.features.feedbackTriage, model: null, escalationModel: null },
  },
});

describe('stored admin AI configuration compatibility', () => {
  it.each([stored, JSON.stringify(stored)])(
    'preserves controls and other features while disabling obsolete feedback model choices',
    value => {
      expect(AdminAiStoredConfigSchema.parse(value)).toEqual(expected);
    }
  );

  it('keeps supported decision models and all defaults unchanged', () => {
    const config = AdminAiConfigSchema.parse({
      features: { feedbackTriage: { model: DECISION_MODEL_IDS[0], escalationModel: DECISION_MODEL_IDS[1] } },
    });
    expect(AdminAiStoredConfigSchema.parse(config)).toEqual(config);
    expect(AdminAiStoredConfigSchema.parse({})).toEqual(AdminAiConfigSchema.parse({}));
  });

  it('continues to reject obsolete models on new writes and unknown models on reads', () => {
    expect(AdminAiConfigSchema.safeParse(stored).success).toBe(false);
    expect(
      AdminAiStoredConfigSchema.safeParse({ features: { feedbackTriage: { model: 'unknown-model' } } }).success
    ).toBe(false);
  });
});
