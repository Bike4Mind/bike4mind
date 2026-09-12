import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import {
  resolveEmbeddingConfig,
  resolveEmbeddingWithKeylessFallback,
  type EmbeddingKeyTable,
} from './resolveEmbeddingConfig';
import { getProviderFromModel } from './getProviderFromModel';
import {
  BedrockEmbeddingModel,
  OllamaEmbeddingModel,
  OpenAIEmbeddingModel,
  VoyageAIEmbeddingModel,
} from '@bike4mind/common';

const FULL: EmbeddingKeyTable = { openai: 'sk-test', voyageai: 'pa-test', ollama: 'http://localhost:11434' };

describe('resolveEmbeddingConfig', () => {
  // Every provider against a table that has its credential and one that does not.
  // Exhaustive on purpose: adding a provider should fail here rather than at a call site.
  describe.each([
    {
      provider: ModelBackend.OpenAI,
      configKey: 'openaiApiKey',
      value: 'sk-test',
      credential: 'openai' as const,
    },
    {
      provider: ModelBackend.VoyageAI,
      configKey: 'voyageApiKey',
      value: 'pa-test',
      credential: 'voyageai' as const,
    },
    {
      provider: ModelBackend.Ollama,
      configKey: 'ollamaBaseUrl',
      value: 'http://localhost:11434',
      credential: 'ollama' as const,
    },
  ])('$provider (keyed)', ({ provider, configKey, value, credential }) => {
    it('sets only its own config field when the credential is present', () => {
      const { config, missing } = resolveEmbeddingConfig(provider, FULL);
      expect(missing).toBeNull();
      expect(config).toEqual({ [configKey]: value });
    });

    it('reports the missing credential and leaves the config empty when absent', () => {
      const { config, missing } = resolveEmbeddingConfig(provider, { ...FULL, [credential]: undefined });
      expect(missing).toBe(credential);
      expect(config).toEqual({});
    });

    it.each([
      ['empty string', ''],
      ['null', null],
    ])('treats a %s credential as missing, not as usable', (_label, empty) => {
      const { config, missing } = resolveEmbeddingConfig(provider, { ...FULL, [credential]: empty });
      expect(missing).toBe(credential);
      expect(config).toEqual({});
    });
  });

  // getEffectiveLLMApiKeys emits the literal 'expired' sentinel for an expired per-user key. It must
  // be treated as missing here - not forwarded as a bearer token - so an expired key degrades like
  // every other LLM consumer instead of coming back as an opaque provider 401. Ollama carries a base
  // URL, not a secret, so the sentinel is not applicable there.
  describe.each([
    { provider: ModelBackend.OpenAI, credential: 'openai' as const },
    { provider: ModelBackend.VoyageAI, credential: 'voyageai' as const },
  ])('$provider expired sentinel', ({ provider, credential }) => {
    it("treats the 'expired' sentinel as missing, not as a usable key", () => {
      const { config, missing } = resolveEmbeddingConfig(provider, { ...FULL, [credential]: 'expired' });
      expect(missing).toBe(credential);
      expect(config).toEqual({});
    });
  });

  // The regression this helper exists for. A keyless provider's ready state is an empty
  // config, which the two broken call-site shapes could not represent: one assumed an
  // unrecognised provider needed a key, the other read "no config fields set" as
  // "no credentials available" and skipped embedding.
  describe('Bedrock (keyless)', () => {
    it('is ready with an empty config and never reports a missing credential', () => {
      const { config, missing } = resolveEmbeddingConfig(ModelBackend.Bedrock, FULL);
      expect(missing).toBeNull();
      expect(config).toEqual({});
    });

    it('stays ready when no key table exists at all', () => {
      for (const table of [null, undefined, {}]) {
        const { config, missing } = resolveEmbeddingConfig(ModelBackend.Bedrock, table);
        expect(missing).toBeNull();
        expect(config).toEqual({});
      }
    });

    it('does not borrow another provider credential that happens to be present', () => {
      const { config } = resolveEmbeddingConfig(ModelBackend.Bedrock, FULL);
      expect(config.openaiApiKey).toBeUndefined();
      expect(config.voyageApiKey).toBeUndefined();
      expect(config.ollamaBaseUrl).toBeUndefined();
    });
  });

  describe('null / undefined key table', () => {
    it.each([
      [ModelBackend.OpenAI, 'openai'],
      [ModelBackend.VoyageAI, 'voyageai'],
      [ModelBackend.Ollama, 'ollama'],
    ])('reports %s as missing rather than throwing', (provider, credential) => {
      for (const table of [null, undefined]) {
        expect(resolveEmbeddingConfig(provider, table)).toEqual({ config: {}, missing: credential });
      }
    });
  });

  // Guards the seam this helper sits on: a model id must resolve to a provider this
  // function handles. A new provider reaching only one of the two is the defect that
  // produced the original bug.
  describe('composes with getProviderFromModel', () => {
    it.each([
      [OpenAIEmbeddingModel.TEXT_EMBEDDING_3_SMALL, false],
      [BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2, true],
      [OllamaEmbeddingModel.NOMIC_EMBED_TEXT, false],
      ['voyage-3', false],
    ] as Array<[string, boolean]>)('%s resolves to a handled provider', (model, expectKeyless) => {
      const provider = getProviderFromModel(model);
      const { missing, config } = resolveEmbeddingConfig(provider, FULL);
      expect(missing).toBeNull();
      // Only the keyless provider ends up with nothing to pass the factory.
      expect(Object.keys(config)).toHaveLength(expectKeyless ? 0 : 1);
    });
  });
});

describe('resolveEmbeddingWithKeylessFallback', () => {
  const saved = {
    B4M_SELF_HOST: process.env.B4M_SELF_HOST,
    AWS_LAMBDA_FUNCTION_NAME: process.env.AWS_LAMBDA_FUNCTION_NAME,
  };
  beforeEach(() => {
    delete process.env.B4M_SELF_HOST;
    // hasKeylessCloudEmbedder wants positive evidence of an execution role, which the test runner
    // has none of. Every case here is about a HOSTED stage, so state that once rather than let
    // each assertion inherit whichever runtime the suite happens to run on.
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'some-stage-fabFileVectorize';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('leaves a satisfied model untouched', () => {
    const r = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, FULL);
    expect(r).toEqual({ config: { openaiApiKey: 'sk-test' }, missing: null, model: 'text-embedding-ada-002' });
  });

  it('falls back to Bedrock on a cloud stage with no cloud credential', () => {
    // The whole point: a keyless cloud stage embeds rather than failing every chunk. OPENAI_API_KEY
    // being absent from process.env is NOT what decides this - the empty key table is.
    const r = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, null);
    expect(r).toEqual({
      config: {},
      missing: null,
      model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2,
    });
  });

  it('returns the model it fell back to, not the one it was asked for', () => {
    // Callers stamp the corpus with the returned model; echoing the requested one would label
    // Titan vectors as ada-002 and re-invalidate the corpus on every subsequent run.
    const { model } = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, {
      openai: null,
    });
    expect(model).toBe(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
  });

  it("keeps the requested model when it is THIS CALLER's key that expired, not the deployment's", () => {
    // getEffectiveLLMApiKeys deliberately returns the 'expired' sentinel rather than falling
    // through to the platform demo key, so the user is told their key expired instead of being
    // moved onto the platform's. Reading that as "this deployment is keyless" would substitute
    // Titan for one caller on keyed production and query a space the corpus was never written in.
    const r = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, {
      openai: 'expired',
    });
    expect(r.model).toBe(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002);
    expect(r.missing).toBe('openai');
  });

  it('applies the same expired-key rule to VoyageAI', () => {
    const r = resolveEmbeddingWithKeylessFallback(VoyageAIEmbeddingModel.VOYAGE_3, { voyageai: 'expired' });
    expect(r.model).toBe(VoyageAIEmbeddingModel.VOYAGE_3);
    expect(r.missing).toBe('voyageai');
  });

  it('still falls back when the slot is genuinely empty rather than expired', () => {
    // The distinction is the whole point: absent means the deployment holds no credential and
    // Bedrock is the only way to answer at all; 'expired' means one caller's key lapsed.
    const { model } = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, {
      openai: null,
      voyageai: 'expired',
    });
    expect(model).toBe(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2);
  });

  it('never falls back on self-host, which has no AWS role to reach Bedrock with', () => {
    // Self-host must keep the actionable OPENAI_API_KEY / OLLAMA_BASE_URL error rather than
    // trading it for an opaque AWS credential failure.
    process.env.B4M_SELF_HOST = 'true';
    const r = resolveEmbeddingWithKeylessFallback(OpenAIEmbeddingModel.TEXT_EMBEDDING_ADA_002, null);
    expect(r).toEqual({ config: {}, missing: 'openai', model: 'text-embedding-ada-002' });
  });

  it('never overrides a missing Ollama base URL', () => {
    const r = resolveEmbeddingWithKeylessFallback(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B, null);
    expect(r.missing).toBe('ollama');
    expect(r.model).toBe(OllamaEmbeddingModel.QWEN3_EMBEDDING_0_6B);
  });

  it('is a no-op for a model that already needs no credential', () => {
    const r = resolveEmbeddingWithKeylessFallback(BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2, null);
    expect(r).toEqual({ config: {}, missing: null, model: BedrockEmbeddingModel.TITAN_TEXT_EMBEDDINGS_V2 });
  });
});
