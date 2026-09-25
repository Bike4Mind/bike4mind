import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';

const getAvailableModels = vi.fn();
const findOne = vi.fn();
// Identity, not values: the values are pinned where the constant lives.
const { PICKER_LISTING_OPTIONS } = vi.hoisted(() => ({ PICKER_LISTING_OPTIONS: { picker: 'shared' } }));

vi.mock('@bike4mind/llm-adapters', () => ({
  PICKER_LISTING_OPTIONS,
  buildApiKeyTable: (keys: unknown) => keys,
  getAvailableModels: (...args: unknown[]) => getAvailableModels(...args),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({ openai: 'sk-openai' })) },
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('@bike4mind/observability', () => ({ Logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('../di/registry', () => ({
  getSlackDb: () => ({ apiKeyRepository: {}, adminSettingsRepository: {}, AdminSettings: { findOne } }),
}));

import { buildSlackModelOptionsFromDashboard } from './slack-model-options';

const model = (overrides: Partial<ModelInfo>): ModelInfo =>
  ({ id: 'm', name: 'M', backend: ModelBackend.OpenAI, type: 'text', ...overrides }) as ModelInfo;

describe('buildSlackModelOptionsFromDashboard', () => {
  beforeEach(() => {
    getAvailableModels.mockReset();
    findOne.mockReset().mockResolvedValue(null);
  });

  it('lists through the shared fan-out with the picker listing options', async () => {
    getAvailableModels.mockResolvedValue([]);

    await buildSlackModelOptionsFromDashboard();

    expect(getAvailableModels).toHaveBeenCalledWith({ openai: 'sk-openai' }, PICKER_LISTING_OPTIONS);
    expect(getAvailableModels.mock.calls[0][1]).toBe(PICKER_LISTING_OPTIONS);
  });

  it('groups every backend the fan-out returns, labeled and in display order', async () => {
    // Before, a backend absent from Slack's own construction map was never fetched
    // at all; now every backend the fan-out lists must reach a labeled group.
    const allBackends = Object.values(ModelBackend);
    getAvailableModels.mockResolvedValue(
      [...allBackends].reverse().map(backend => model({ id: `${backend}-id`, name: backend, backend }))
    );

    const { option_groups, flat } = await buildSlackModelOptionsFromDashboard();

    expect(option_groups.map(g => g.label.text)).toEqual([
      'OpenAI',
      'Anthropic',
      'Bedrock',
      'Gemini',
      'xAI',
      'Moonshot (Kimi)',
      'DeepSeek',
      'Ollama',
      'AWS',
      'Black Forest Labs',
      'Voyage AI',
      'Local image',
    ]);
    expect(flat).toHaveLength(allBackends.length);
  });

  it('drops non-text and admin-disabled models', async () => {
    findOne.mockResolvedValue({ settingValue: [{ id: 'disabled', enabled: false }] });
    getAvailableModels.mockResolvedValue([
      model({ id: 'keep' }),
      model({ id: 'image', type: 'image' }),
      model({ id: 'disabled' }),
    ]);

    const { flat } = await buildSlackModelOptionsFromDashboard();

    expect(flat.map(o => o.value)).toEqual(['keep']);
  });

  it('returns an empty dropdown rather than throwing when listing fails', async () => {
    getAvailableModels.mockRejectedValue(new Error('boom'));

    await expect(buildSlackModelOptionsFromDashboard()).resolves.toEqual({ option_groups: [], flat: [] });
  });
});
