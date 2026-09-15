import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/deepseek/empty.json';
import malformed from './__fixtures__/deepseek/malformed.json';
import models from './__fixtures__/deepseek/models.json';
import unknownNamespace from './__fixtures__/deepseek/unknown-namespace.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { createDeepSeekSource, DEEPSEEK_MODELS_URL, normalizeDeepSeekModels } from './deepseek';

describe('deepseek source normalization', () => {
  it('emits one text record per listed model', () => {
    const records = normalizeDeepSeekModels(models);
    expect(records.map(r => r.modelId)).toEqual(['deepseek-flash']);
    for (const record of records) {
      expect(record.patch.backend).toBe('deepseek');
      expect(record.patch.vendor).toBe('deepseek');
      expect(record.patch.type).toBe('text');
      expect(record.patch.canStream).toBe(true);
    }
  });

  it('claims no context window, capability flag or pricing the endpoint does not publish', () => {
    // The endpoint is id/object/owned_by only, so none of these can be stated
    // without inventing data - unlike ./kimi, whose richer listing earns them.
    for (const record of normalizeDeepSeekModels(models)) {
      expect(record.patch).not.toHaveProperty('contextWindow');
      expect(record.patch).not.toHaveProperty('supportsVision');
      expect(record.patch).not.toHaveProperty('reasoning');
      expect(record.pricing).toBeUndefined();
    }
  });

  it('never invents a display name, which the endpoint does not publish', () => {
    // `name: id` would overwrite every seeded label with a lowercase id and
    // append a row on every single run.
    for (const record of normalizeDeepSeekModels(models)) {
      expect(record.patch).not.toHaveProperty('name');
    }
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeDeepSeekModels(malformed).map(r => r.modelId)).toEqual(['deepseek-flash']);
  });

  it('classifies by modality marker before namespace, sorts by id, and skips a non-model object', () => {
    const records = normalizeDeepSeekModels(unknownNamespace);
    // Listed chat-first, returned embedding-first: the sort is what makes a run
    // over an unordered listing produce the same plan every time.
    expect(records.map(r => r.modelId)).toEqual(['deepseek-embedding-1', 'deepseek-flash']);
    // The marker wins over the namespace: an embedding model must never be
    // labelled 'text' just because it sits in the deepseek- namespace.
    expect(records.find(r => r.modelId === 'deepseek-embedding-1')?.patch.type).toBe('embedding');
  });

  it('reads a modality marker inside the one deepseek- namespace', () => {
    const typeOf = (id: string) => normalizeDeepSeekModels({ data: [{ id, object: 'model' }] })[0]?.patch.type;
    expect(typeOf('deepseek-tts-preview')).toBe('tts');
    expect(typeOf('deepseek-embedding-v1')).toBe('embedding');
    expect(typeOf('deepseek-flash')).toBe('text');
  });

  it('returns nothing for an empty list rather than inventing rows', () => {
    expect(normalizeDeepSeekModels(empty)).toEqual([]);
  });

  it('tolerates a payload that is not a list at all', () => {
    expect(normalizeDeepSeekModels(null)).toEqual([]);
    expect(normalizeDeepSeekModels({ data: 'nope' })).toEqual([]);
  });
});

describe('deepseek source fetch', () => {
  it('is configured only when a key is resolved', () => {
    const source = createDeepSeekSource();
    expect(source.isConfigured({ deepseek: 'sk-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ deepseek: null } as never, {})).toBe(false);
  });

  it('claims authority for the deepseek backend on a successful listing', async () => {
    const restore = stubFetch({ body: models });
    try {
      const result = await createDeepSeekSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // One endpoint lists everything, so a 200 IS exhaustive - which is what
        // lets absence bookkeeping eventually deprecate a withdrawn model.
        expect(result.authoritativeFor).toEqual(['deepseek']);
        expect(result.records).toHaveLength(1);
      }
    } finally {
      restore();
    }
  });

  it('sends the bearer credential to the models endpoint', async () => {
    const seen: string[] = [];
    const restore = stubFetch(url => {
      seen.push(url);
      return { body: models };
    });
    try {
      await createDeepSeekSource().fetch(makeContext());
      expect(seen).toEqual([DEEPSEEK_MODELS_URL]);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty when the provider lists nothing', async () => {
    const restore = stubFetch({ body: empty });
    try {
      // A 200 listing zero models must not read as "DeepSeek retired everything".
      expect((await createDeepSeekSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails on a body that is not JSON', async () => {
    const restore = stubFetch({ raw: '<html>gateway</html>' });
    try {
      expect((await createDeepSeekSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createDeepSeekSource());
});
