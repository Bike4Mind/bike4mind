import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  rowsInForce: vi.fn(),
  whenCatalogSeeded: vi.fn(),
  getAvailableModels: vi.fn(),
  getEffectiveLLMApiKeys: vi.fn(),
}));
vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: { getSettingsValue: mocks.getSettingsValue },
  apiKeyRepository: {},
  modelCatalogRepository: { rowsInForce: mocks.rowsInForce },
  whenCatalogSeeded: mocks.whenCatalogSeeded,
}));
vi.mock('@bike4mind/services', () => ({ apiKeyService: { getEffectiveLLMApiKeys: mocks.getEffectiveLLMApiKeys } }));
vi.mock('@bike4mind/services/llm/agents/ServerAgentStore', () => ({ builtInAgentModelReferences: () => ({}) }));
vi.mock('@bike4mind/utils', () => ({
  DEFAULT_FALLBACK_CHAIN: [],
  FALLBACK_PREFERENCES: {},
  getSettingsByNames: vi.fn(),
}));
vi.mock('@bike4mind/llm-adapters', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/llm-adapters')>()),
  getAvailableModels: mocks.getAvailableModels,
}));

const { modelReferenceReport } = await import('./modelReferenceReport');

beforeEach(() => {
  vi.resetAllMocks();
  mocks.whenCatalogSeeded.mockResolvedValue(true);
  mocks.getEffectiveLLMApiKeys.mockResolvedValue({ anthropic: 'test-key' });
  mocks.getAvailableModels.mockResolvedValue([{ id: 'live' }]);
  mocks.rowsInForce.mockResolvedValue([]);
  mocks.getSettingsValue.mockImplementation(async (key: string) => {
    if (key === 'orchestrationDefaults') {
      return {
        fallbackModels: ['live'],
        intentClassifier: { enabled: true, primaryModel: 'missing', fallbackModels: ['live'] },
      };
    }
    return key === 'DefaultAPIModel' ? 'live' : '';
  });
});

describe('modelReferenceReport', () => {
  it('audits configured defaults with the system key table', async () => {
    const report = await modelReferenceReport();
    expect(report).toEqual(
      expect.arrayContaining([
        {
          surface: 'configured-model',
          key: 'orchestrationDefaults.intentClassifier.primaryModel',
          referencedId: 'missing',
          problem: 'unknown',
        },
      ])
    );
    expect(mocks.getAvailableModels).toHaveBeenCalledWith(
      expect.objectContaining({ anthropic: 'test-key' }),
      expect.objectContaining({ includePrivate: true, perBackendTimeoutMs: 10_000 })
    );
    expect(mocks.getEffectiveLLMApiKeys).toHaveBeenCalledWith(null, expect.anything());
  });

  it('fails instead of publishing a clean report when catalog bootstrap or settings reads fail', async () => {
    mocks.whenCatalogSeeded.mockResolvedValue(false);
    await expect(modelReferenceReport()).rejects.toThrow('Catalog bootstrap failed');
    expect(mocks.getAvailableModels).not.toHaveBeenCalled();
    mocks.whenCatalogSeeded.mockResolvedValue(true);
    mocks.getSettingsValue.mockRejectedValue(new Error('database unavailable'));
    await expect(modelReferenceReport()).rejects.toThrow('database unavailable');
  });

  it('audits the SRE diagnostician pin of each enabled repo only', async () => {
    mocks.getSettingsValue.mockImplementation(async (key: string) => {
      if (key === 'orchestrationDefaults') {
        return { fallbackModels: [], intentClassifier: { enabled: false, primaryModel: 'live', fallbackModels: [] } };
      }
      if (key === 'sreAgentConfig') {
        return {
          repos: [
            { enabled: false, modelId: 'paused-repo-model' },
            { enabled: true, modelId: 'missing' },
          ],
        };
      }
      return '';
    });
    const report = await modelReferenceReport();
    expect(report.filter(reference => reference.surface === 'configured-model')).toEqual([
      {
        surface: 'configured-model',
        key: 'sreAgentConfig.repos.1.modelId',
        referencedId: 'missing',
        problem: 'unknown',
      },
    ]);
  });

  it('does not audit the voice transcription model against the completion model list', async () => {
    mocks.getSettingsValue.mockImplementation(async (key: string) => {
      if (key === 'orchestrationDefaults') {
        return { fallbackModels: [], intentClassifier: { enabled: false, primaryModel: 'live', fallbackModels: [] } };
      }
      return key === 'voiceSessionTranscriptionModel' ? 'gpt-4o-mini-transcribe' : '';
    });
    const report = await modelReferenceReport();
    expect(report.filter(reference => reference.surface === 'configured-model')).toEqual([]);
  });

  it('does not audit the disabled intent classifier', async () => {
    mocks.getSettingsValue.mockImplementation(async (key: string) =>
      key === 'orchestrationDefaults'
        ? { fallbackModels: [], intentClassifier: { enabled: false, primaryModel: 'missing', fallbackModels: [] } }
        : ''
    );
    const report = await modelReferenceReport();
    expect(report.filter(reference => reference.surface === 'configured-model')).toEqual([]);
  });
});
