import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';
import {
  ANTHROPIC_FEDERATED_KEY,
  AnthropicBackend,
  OPENAI_FEDERATED_KEY,
  OpenAIBackend,
  getAvailableModels,
  getLlmByModel,
  setModelCatalogProvider,
} from './index';

const model = (backend: ModelBackend, adapterFamily?: ModelInfo['adapterFamily']): ModelInfo => ({
  id: `${backend}-test`,
  type: 'text',
  name: `${backend} test`,
  backend,
  adapterFamily,
  supportsImageVariation: false,
  contextWindow: 1000,
  max_tokens: 100,
  pricing: {},
});

const clientKey = (backend: unknown): unknown => (backend as { _api: { apiKey: unknown } })._api.apiKey;
const logger = new Logger();
const listingOptions = { isSelfHost: true, bedrockReachable: false };

describe('trusted symbol key tables', () => {
  beforeEach(() => {
    vi.stubEnv('PROVIDER_WIF_TOKEN_SOURCE', 'aws-sts');
    vi.stubEnv('OPENAI_IDENTITY_PROVIDER_ID', 'idp_table');
    vi.stubEnv('OPENAI_SERVICE_ACCOUNT_ID', 'sa_table');
    vi.stubEnv('OPENAI_WIF_AUDIENCE', 'openai-table-aud');
    vi.stubEnv('ANTHROPIC_FEDERATION_RULE_ID', 'rule_table');
    vi.stubEnv('ANTHROPIC_ORGANIZATION_ID', 'org_table');
    vi.stubEnv('ANTHROPIC_WIF_AUDIENCE', 'anthropic-table-aud');
    setModelCatalogProvider(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setModelCatalogProvider(null);
  });

  it.each([
    [ModelBackend.OpenAI, undefined, OPENAI_FEDERATED_KEY],
    [ModelBackend.OpenAI, 'openai-chat', OPENAI_FEDERATED_KEY],
    [ModelBackend.OpenAI, 'openai-responses', OPENAI_FEDERATED_KEY],
    [ModelBackend.Anthropic, undefined, ANTHROPIC_FEDERATED_KEY],
    [ModelBackend.Anthropic, 'anthropic-messages', ANTHROPIC_FEDERATED_KEY],
  ] as const)('supports a trusted symbol for %s / %s', (backend, adapterFamily, sentinel) => {
    const table = { [backend]: sentinel };
    expect(clientKey(getLlmByModel(table, { modelInfo: model(backend, adapterFamily), logger }))).toBeNull();
    expect(
      clientKey(getLlmByModel({ [backend]: 'federated' }, { modelInfo: model(backend, adapterFamily), logger }))
    ).toBe('federated');
  });

  it('lists both providers with inferred symbol-valued keys', async () => {
    const openaiListing = vi
      .spyOn(OpenAIBackend.prototype, 'getModelInfo')
      .mockResolvedValue([model(ModelBackend.OpenAI)]);
    const anthropicListing = vi
      .spyOn(AnthropicBackend.prototype, 'getModelInfo')
      .mockResolvedValue([model(ModelBackend.Anthropic)]);
    // Matches callers that choose a static key or a federation sentinel before building a table.
    const openaiKey = process.env.OPENAI_API_KEY || OPENAI_FEDERATED_KEY;
    const anthropicKey = process.env.ANTHROPIC_API_KEY || ANTHROPIC_FEDERATED_KEY;
    const table = { ...(openaiKey ? { openai: openaiKey } : {}), ...(anthropicKey ? { anthropic: anthropicKey } : {}) };
    const models = await getAvailableModels(table, listingOptions);
    expect(models.map(entry => entry.id)).toEqual(expect.arrayContaining(['openai-test', 'anthropic-test']));
    expect(openaiListing).toHaveBeenCalledTimes(1);
    expect(anthropicListing).toHaveBeenCalledTimes(1);
  });

  it('keeps symbol credentials separate from static strings in the model-list cache', async () => {
    const seenCredentials: unknown[] = [];
    const listing = vi.spyOn(OpenAIBackend.prototype, 'getModelInfo').mockImplementation(async function (
      this: OpenAIBackend
    ) {
      seenCredentials.push(clientKey(this));
      return [model(ModelBackend.OpenAI)];
    });
    const symbolTable = { openai: OPENAI_FEDERATED_KEY };
    const first = await getAvailableModels(symbolTable, listingOptions);
    expect(await getAvailableModels(symbolTable, listingOptions)).toBe(first);
    expect(listing).toHaveBeenCalledTimes(1);
    await getAvailableModels({ openai: 'federated' }, listingOptions);
    expect(listing).toHaveBeenCalledTimes(2);
    expect(seenCredentials).toEqual([null, 'federated']);
  });

  it('rejects a symbol intended for the other provider', async () => {
    const table = { openai: ANTHROPIC_FEDERATED_KEY };
    expect(() => getLlmByModel(table, { modelInfo: model(ModelBackend.OpenAI), logger })).toThrow(
      /Unrecognized federated provider credential/
    );
    await expect(getAvailableModels(table, listingOptions)).rejects.toThrow(
      /Unrecognized federated provider credential/
    );
  });

  it('rejects unknown symbols instead of falling back to environment credentials', async () => {
    const table = { openai: Symbol('untrusted') };
    expect(() => getLlmByModel(table, { modelInfo: model(ModelBackend.OpenAI), logger })).toThrow(
      /Unrecognized federated provider credential/
    );
    await expect(getAvailableModels(table, listingOptions)).rejects.toThrow(
      /Unrecognized federated provider credential/
    );
  });
});
