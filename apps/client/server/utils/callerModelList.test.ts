import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    getAvailableModels: vi.fn(),
    getSupersededModels: vi.fn(),
    getSettingsMap: vi.fn(),
  },
}));

vi.mock('@bike4mind/llm-adapters', () => ({
  PICKER_LISTING_OPTIONS: {},
  buildApiKeyTable: () => ({}),
  getAvailableModels: (...a: unknown[]) => mocks.getAvailableModels(...a),
  getSupersededModels: (...a: unknown[]) => mocks.getSupersededModels(...a),
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: vi.fn(async () => ({})) },
}));
vi.mock('@bike4mind/database', () => ({
  apiKeyRepository: {},
  adminSettingsRepository: {},
  cacheRepository: { findOne: vi.fn(async () => null), createOrUpdate: vi.fn(async () => undefined) },
}));
// The real getSettingsValue, so the setting is parsed exactly as production parses it.
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: (...a: unknown[]) => mocks.getSettingsMap(...a),
}));

import { getCallerModelList } from './callerModelList';

const textModel = (id: string, overrides: Partial<ModelInfo> = {}): ModelInfo =>
  ({
    id,
    type: 'text',
    name: id,
    backend: ModelBackend.OpenAI,
    contextWindow: 128_000,
    max_tokens: 16_000,
    supportsImageVariation: false,
    pricing: { 128_000: { input: 2e-6, output: 8e-6 } },
    ...overrides,
  }) as ModelInfo;

const priced = textModel('priced');
const unpriced = textModel('unpriced', { pricing: {} });
const free = textModel('free', { freeToRun: true, pricing: { 128_000: { input: 0, output: 0 } } });

const listedIds = async () => (await getCallerModelList('user-1', { log: vi.fn() })).models.map(model => model.id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAvailableModels.mockResolvedValue([priced, unpriced, free]);
  mocks.getSupersededModels.mockReturnValue([]);
});

describe('getCallerModelList unpriced text models', () => {
  it('drops an unpriced text model when credits are enforced', async () => {
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'true' });

    expect(await listedIds()).toEqual(['priced', 'free']);
    // The upgrade offers are resolved against the same filtered list.
    expect(mocks.getSupersededModels).toHaveBeenCalledWith([priced, free]);
  });

  it('lists it when credits are off', async () => {
    mocks.getSettingsMap.mockResolvedValue({ enforceCredits: 'false' });

    expect(await listedIds()).toEqual(['priced', 'unpriced', 'free']);
  });
});
