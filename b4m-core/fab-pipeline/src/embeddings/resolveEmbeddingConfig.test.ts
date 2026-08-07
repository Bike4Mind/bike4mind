import { describe, it, expect } from 'vitest';
import { ModelBackend } from '@bike4mind/common';
import { resolveEmbeddingConfig, type EmbeddingKeyTable } from './resolveEmbeddingConfig';
import { getProviderFromModel } from './getProviderFromModel';
import { BedrockEmbeddingModel, OllamaEmbeddingModel, OpenAIEmbeddingModel } from '@bike4mind/common';

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
