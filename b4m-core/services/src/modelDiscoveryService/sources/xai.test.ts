import { describe, expect, it } from 'vitest';
import embeddingModels from './__fixtures__/xai/embedding-models.json';
import empty from './__fixtures__/xai/empty.json';
import expected from './__fixtures__/xai/expected.json';
import imageModels from './__fixtures__/xai/image-generation-models.json';
import languageModels from './__fixtures__/xai/language-models.json';
import malformed from './__fixtures__/xai/malformed.json';
import models from './__fixtures__/xai/models.json';
import unknownEnum from './__fixtures__/xai/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import {
  CENTS_PER_100M_TOKENS_TO_USD_PER_MTOK,
  CENTS_PER_1M_TOKENS_TO_USD_PER_MTOK,
  createXaiSource,
  normalizeXai,
  XAI_EMBEDDING_MODELS_URL,
  XAI_IMAGE_MODELS_URL,
  XAI_LANGUAGE_MODELS_URL,
  XAI_MODELS_URL,
} from './xai';

const all = { languageModels, models, imageModels, embeddingModels };
const byId = (payloads: Parameters<typeof normalizeXai>[0]) =>
  new Map(normalizeXai(payloads).map(record => [record.modelId, record]));

describe('xai unit conversions', () => {
  // Crossing these two constants is a 100x billing error, so each is asserted
  // against a rate xAI actually publishes rather than against the other.
  it('language models: cents per 100M tokens divided by 1e4 gives $/MTok', () => {
    const grok4 = byId(all).get('grok-4-0709');
    expect(grok4?.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });

    const grok45 = byId(all).get('grok-4.5');
    expect(grok45?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 6 });
  });

  it('embedding models: cents per 1M tokens divided by 100 gives $/MTok', () => {
    const embedding = byId(all).get('grok-embedding-1');
    expect(embedding?.pricing).toEqual({ inputPerMTok: 0.02, outputPerMTok: 0.02 });
  });

  it('keeps the two constants two orders of magnitude apart', () => {
    expect(CENTS_PER_100M_TOKENS_TO_USD_PER_MTOK / CENTS_PER_1M_TOKENS_TO_USD_PER_MTOK).toBe(100);
    // The failure mode spelled out: the embedding rate under the language
    // constant is 100x too cheap, the language rate under the embedding
    // constant is 100x too dear.
    expect(2 / CENTS_PER_100M_TOKENS_TO_USD_PER_MTOK).toBe(0.0002);
    expect(30000 / CENTS_PER_1M_TOKENS_TO_USD_PER_MTOK).toBe(300);
  });

  it('treats an all-zero price pair as unpriced rather than free', () => {
    const zeroed = normalizeXai({
      languageModels: { models: [{ id: 'grok-x', prompt_text_token_price: 0, completion_text_token_price: 0 }] },
      models: { data: [] },
    });
    expect(zeroed[0]?.pricing).toBeUndefined();
  });
});

describe('xai two-endpoint join', () => {
  it('matches the golden file', () => {
    expect(normalizeXai(all)).toEqual(expected);
  });

  it('takes context_length from /v1/models, which /v1/language-models does not carry', () => {
    expect(byId(all).get('grok-4.5')?.patch.contextWindow).toBe(500000);
    expect(byId(all).get('grok-3-mini')?.patch.contextWindow).toBe(131072);
  });

  it('still emits a language model absent from /v1/models, without a context window', () => {
    const partial = byId(all).get('grok-4.20-multi-agent-0309');
    expect(partial).toBeDefined();
    expect(partial?.patch).not.toHaveProperty('contextWindow');
    expect(partial?.pricing).toEqual({ inputPerMTok: 5, outputPerMTok: 20 });
  });

  it('does not emit an id that only /v1/models knows, because its modality is unknown', () => {
    expect(byId(all).has('grok-4.30-preview')).toBe(false);
  });

  it('emits image models from their own endpoint, priced nowhere in tokens', () => {
    const image = byId(all).get('grok-imagine-image-quality');
    expect(image?.patch.type).toBe('image');
    expect(image?.patch.supportsImageVariation).toBe(true);
    // Per-image pricing has no token unit, so it is left to the price catalog.
    expect(image?.pricing).toBeUndefined();
  });

  it('falls back to a zero context window for a model /v1/models omits', () => {
    const records = normalizeXai({
      languageModels: { models: [] },
      models: { data: [] },
      imageModels: { models: [{ id: 'grok-imagine-image', input_modalities: ['text'] }] },
    });
    expect(records[0]?.patch.contextWindow).toBe(0);
  });
});

describe('xai normalization edge cases', () => {
  it('skips malformed entries and keeps the rest', () => {
    const records = normalizeXai({ languageModels: malformed, models: { data: [] } });
    expect(records.map(record => record.modelId)).toEqual(['grok-4.5', 'grok-bad-price']);
    expect(records.find(record => record.modelId === 'grok-bad-price')?.pricing).toBeUndefined();
  });

  it('tolerates unknown modality values instead of dropping the model', () => {
    const records = normalizeXai({ languageModels: unknownEnum, models: { data: [] } });
    expect(records).toHaveLength(1);
    expect(records[0]?.patch.supportsVision).toBe(true);
    expect(records[0]?.patch).not.toHaveProperty('reasoning_mode');
  });

  it('returns nothing for an empty listing', () => {
    expect(normalizeXai({ languageModels: empty, models: { data: [] } })).toEqual([]);
  });
});

describe('xai source fetch', () => {
  const route = (url: string) => {
    if (url === XAI_LANGUAGE_MODELS_URL) return { body: languageModels };
    if (url === XAI_MODELS_URL) return { body: models };
    if (url === XAI_IMAGE_MODELS_URL) return { body: imageModels };
    if (url === XAI_EMBEDDING_MODELS_URL) return { body: embeddingModels };
    return undefined;
  };

  it('is configured only when a key is resolved', () => {
    const source = createXaiSource();
    expect(source.isConfigured({ xai: 'xai-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ xai: null } as never, {})).toBe(false);
  });

  it('claims authority for the xai backend', async () => {
    const restore = stubFetch(route);
    try {
      const result = await createXaiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toEqual(['xai']);
    } finally {
      restore();
    }
  });

  it('fails when /v1/models is unavailable, rather than shipping context-less records', async () => {
    const restore = stubFetch(url => (url === XAI_MODELS_URL ? { status: 500, body: {} } : route(url)));
    try {
      expect((await createXaiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('survives a missing image or embedding endpoint', async () => {
    const restore = stubFetch(url =>
      url === XAI_IMAGE_MODELS_URL || url === XAI_EMBEDDING_MODELS_URL ? { status: 404, body: {} } : route(url)
    );
    try {
      const result = await createXaiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.records.some(record => record.patch.type === 'image')).toBe(false);
    } finally {
      restore();
    }
  });

  it('drops the authority claim when a best-effort listing fails', async () => {
    const restore = stubFetch(url => (url === XAI_IMAGE_MODELS_URL ? { status: 503, body: {} } : route(url)));
    try {
      const result = await createXaiSource().fetch(makeContext());

      expect(result.ok).toBe(true);
      if (result.ok) {
        // The text models still land; what is refused is the claim that this
        // listing is exhaustive. grok-imagine-image-quality comes only from the
        // image endpoint, so absence bookkeeping over a partial sweep would
        // count it as missing and eventually deprecate it.
        expect(result.records.length).toBeGreaterThan(0);
        expect(result.authoritativeFor).toEqual([]);
      }
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createXaiSource());
});
