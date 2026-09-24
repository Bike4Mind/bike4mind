import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';

const {
  mockAdminSettings,
  mockLogger,
  mockGetAvailableModels,
  mockGetLlmByModel,
  mockGetEffectiveLLMApiKeys,
  mockGetDefaultImageModel,
} = vi.hoisted(() => ({
  mockAdminSettings: { findOne: vi.fn(), findOneAndUpdate: vi.fn() },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockGetAvailableModels: vi.fn(),
  mockGetLlmByModel: vi.fn(),
  mockGetEffectiveLLMApiKeys: vi.fn(),
  mockGetDefaultImageModel: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({
  AdminSettings: mockAdminSettings,
  apiKeyRepository: {},
  adminSettingsRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  apiKeyService: { getEffectiveLLMApiKeys: mockGetEffectiveLLMApiKeys, getEffectiveApiKey: vi.fn() },
}));
// See the note in operationsModelService.selfhost.test.ts: buildApiKeyTable is
// the real one on purpose.
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: mockGetAvailableModels,
  getLlmByModel: mockGetLlmByModel,
}));
vi.mock('@bike4mind/observability', () => ({
  Logger: vi.fn(function () {
    return mockLogger;
  }),
}));
vi.mock('@bike4mind/utils', () => ({ getSettingsByNames: vi.fn() }));
vi.mock('../server/utils/modelResolvers', () => ({
  getDefaultImageModel: mockGetDefaultImageModel,
  getApiKeyTypeFromBackend: vi.fn(),
}));

const { OperationsModelService } = await import('./operationsModelService');

const model = (id: string, type: string, backend: ModelBackend): ModelInfo => ({ id, type, backend }) as ModelInfo;

const GPT_MINI = model('gpt-4o-mini', 'text', ModelBackend.OpenAI);
const OLLAMA_CHAT = model('qwen2.5-coder:7b', 'text', ModelBackend.Ollama);
const noCloudKeys = {
  openai: null,
  anthropic: null,
  gemini: null,
  bfl: null,
  ollama: 'http://localhost:11434',
  xai: null,
};

describe('OperationsModelService.getOperationsTextModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
    mockGetLlmByModel.mockReturnValue({ complete: vi.fn() });
  });
  afterEach(() => {
    delete process.env.B4M_SELF_HOST;
    delete process.env.OLLAMA_PULL_MODELS;
  });

  it('resolves a text model with no image or speech, and does not touch getDefaultImageModel', async () => {
    process.env.B4M_SELF_HOST = 'true';
    process.env.OLLAMA_PULL_MODELS = 'qwen2.5-coder:7b';
    mockAdminSettings.findOne.mockResolvedValue(null); // no configured operations model
    mockGetEffectiveLLMApiKeys.mockResolvedValue(noCloudKeys);
    // Only a text model is available - no image model at all.
    mockGetAvailableModels.mockResolvedValue([OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('qwen2.5-coder:7b');
    expect(result.modelInfo.backend).toBe(ModelBackend.Ollama);
    expect(result.llm).toBeDefined();
    expect('imageLlm' in result).toBe(false);
    expect(mockGetDefaultImageModel).not.toHaveBeenCalled();
  });

  it('honors the admin-configured operations model id', async () => {
    mockAdminSettings.findOne.mockResolvedValue({
      settingValue: { modelId: 'qwen2.5-coder:7b', imageModelId: 'x', speechModelId: 'y' },
    });
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, openai: 'sk-test' });
    mockGetAvailableModels.mockResolvedValue([GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('qwen2.5-coder:7b');
  });

  it('falls back to gpt-4o-mini when no config and a cloud key is present', async () => {
    mockAdminSettings.findOne.mockResolvedValue(null);
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, openai: 'sk-test' });
    mockGetAvailableModels.mockResolvedValue([GPT_MINI, OLLAMA_CHAT]);

    const result = await OperationsModelService.getOperationsTextModel();

    expect(result.modelId).toBe('gpt-4o-mini');
  });
});

// A deployment with no OpenAI key (e.g. a PR preview) cannot run the configured
// gpt-* operations model, so selection falls through to "any text model" - and
// Bedrock enumerates its legacy ids first. AWS denies a Legacy model outright to
// an account that has not invoked it in 30 days, which failed every summarize,
// auto-name and tag event on such a deployment.
describe('OperationsModelService.getOperationsModel without the configured backend', () => {
  const LEGACY_HAIKU = model('anthropic.claude-3-haiku-20240307-v1:0', 'text', ModelBackend.Bedrock);
  const HAIKU_4_5 = model('us.anthropic.claude-haiku-4-5-20251001-v1:0', 'text', ModelBackend.Bedrock);
  const configured = { settingValue: { modelId: 'gpt-4.1-mini-2025-04-14', imageModelId: 'x', speechModelId: 'y' } };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.B4M_SELF_HOST;
    mockGetLlmByModel.mockReturnValue({ complete: vi.fn() });
    mockGetDefaultImageModel.mockReturnValue(undefined);
    mockAdminSettings.findOne.mockReturnValue({ lean: () => ({ exec: async () => configured }) });
    mockGetEffectiveLLMApiKeys.mockResolvedValue({ ...noCloudKeys, ollama: null });
  });

  it('redirects a superseded fallback pick to its available successor', async () => {
    mockGetAvailableModels.mockResolvedValue([LEGACY_HAIKU, HAIKU_4_5]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe(HAIKU_4_5.id);
  });

  it('keeps the superseded pick when its successor is not available', async () => {
    mockGetAvailableModels.mockResolvedValue([LEGACY_HAIKU]);

    const result = await OperationsModelService.getOperationsModel();

    expect(result.modelId).toBe(LEGACY_HAIKU.id);
  });
});
