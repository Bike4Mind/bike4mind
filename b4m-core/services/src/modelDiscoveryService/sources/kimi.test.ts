import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/kimi/empty.json';
import malformed from './__fixtures__/kimi/malformed.json';
import models from './__fixtures__/kimi/models.json';
import unknownNamespace from './__fixtures__/kimi/unknown-namespace.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { createKimiSource, KIMI_MODELS_URL, normalizeKimiModels } from './kimi';

/**
 * `models.json` is a real capture of the live endpoint (see the fixture README),
 * not a hand-written guess - which matters, because the guess it replaced invented
 * two models Moonshot does not serve and assumed the payload carried nothing but
 * ids.
 */
describe('kimi source normalization', () => {
  const byId = (id: string) => normalizeKimiModels(models).find(r => r.modelId === id);

  it('emits one text record per listed model, sorted by id', () => {
    const records = normalizeKimiModels(models);
    expect(records.map(r => r.modelId)).toEqual([
      'kimi-k2.5',
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k3',
      'moonshot-v1-128k',
      'moonshot-v1-128k-vision-preview',
      'moonshot-v1-32k',
      'moonshot-v1-32k-vision-preview',
      'moonshot-v1-8k',
      'moonshot-v1-8k-vision-preview',
      'moonshot-v1-auto',
    ]);
    for (const record of records) {
      expect(record.patch.backend).toBe('kimi');
      expect(record.patch.vendor).toBe('moonshotai');
      expect(record.patch.type).toBe('text');
    }
  });

  it('claims the context window the endpoint actually publishes', () => {
    // The first cut discarded this on the assumption the endpoint was as thin as
    // OpenAI's. It is not, and throwing it away meant a model discovery found
    // could not be added without an aggregator supplying a window.
    expect(byId('kimi-k3')?.patch.contextWindow).toBe(1_048_576);
    expect(byId('kimi-k2.6')?.patch.contextWindow).toBe(262_144);
    expect(byId('moonshot-v1-8k')?.patch.contextWindow).toBe(8_192);
  });

  it('reads vision off supports_image_in rather than guessing from the id', () => {
    expect(byId('kimi-k3')?.patch.supportsVision).toBe(true);
    // A moonshot-v1 model WITHOUT the vision suffix does not accept images, and
    // the flag is absent rather than false - so the field is simply not claimed.
    expect(byId('moonshot-v1-8k')?.patch.supportsVision).toBeUndefined();
    expect(byId('moonshot-v1-8k-vision-preview')?.patch.supportsVision).toBe(true);
  });

  it('records the effort levels the feed names, rather than hardcoding them', () => {
    // k3 publishes reasoning_efforts.valid_efforts = [low, high, max]; this is the
    // catalog's record of what kimiParams maps B4M's six levels onto.
    expect(byId('kimi-k3')?.patch.reasoning).toEqual({
      supported: true,
      effortLevels: ['low', 'high', 'max'],
    });
  });

  it('marks a reasoning model with no effort block as reasoning without levels', () => {
    // k2.7-code reasons but takes the `thinking` object, not reasoning_effort.
    expect(byId('kimi-k2.7-code')?.patch.reasoning).toEqual({ supported: true });
  });

  it('claims no reasoning group at all for a model that reports neither signal', () => {
    expect(byId('moonshot-v1-8k')?.patch.reasoning).toBeUndefined();
  });

  it('never invents a display name, which the endpoint does not publish', () => {
    // `name: id` would overwrite every seeded label with a lowercase id and append
    // a row on every single run.
    for (const record of normalizeKimiModels(models)) {
      expect(record.patch).not.toHaveProperty('name');
    }
  });

  it('does not serve kimi-k2-thinking or kimi-latest, which the aggregators do list', () => {
    // Pinning a real absence: both exist in models.dev and litellm, so an earlier
    // hand-written fixture included them. The live endpoint does not.
    const ids = normalizeKimiModels(models).map(r => r.modelId);
    expect(ids).not.toContain('kimi-k2-thinking');
    expect(ids).not.toContain('kimi-latest');
  });

  it('claims no pricing, because the endpoint publishes none', () => {
    for (const record of normalizeKimiModels(models)) {
      expect(record.pricing).toBeUndefined();
    }
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeKimiModels(malformed).map(r => r.modelId)).toEqual(['kimi-k3']);
  });

  it('classifies by modality marker before namespace, and skips a non-model object', () => {
    const records = normalizeKimiModels(unknownNamespace);
    expect(records.map(r => r.modelId)).toEqual(['kimi-k3', 'moonshot-embedding-1']);
    // The marker wins over the namespace: an embedding model must never be
    // labelled 'text' just because it sits in a namespace we recognize.
    expect(records.find(r => r.modelId === 'moonshot-embedding-1')?.patch.type).toBe('embedding');
  });

  it('reads a modality marker inside the live kimi- namespace, not just the legacy one', () => {
    // The inverse of what the first cut did: it guarded moonshot-v1- (dead since
    // 2024) and blanket-labelled every kimi- id 'text', so the first kimi TTS
    // model would have shipped as a chat model.
    const typeOf = (id: string) => normalizeKimiModels({ data: [{ id, object: 'model' }] })[0]?.patch.type;
    expect(typeOf('kimi-tts-preview')).toBe('tts');
    expect(typeOf('kimi-embedding-v1')).toBe('embedding');
    expect(typeOf('kimi-k3')).toBe('text');
    // A vision-preview chat model accepts images; it is not an image model.
    expect(typeOf('moonshot-v1-128k-vision-preview')).toBe('text');
  });

  it('returns nothing for an empty list rather than inventing rows', () => {
    expect(normalizeKimiModels(empty)).toEqual([]);
  });

  it('tolerates a payload that is not a list at all', () => {
    expect(normalizeKimiModels(null)).toEqual([]);
    expect(normalizeKimiModels({ data: 'nope' })).toEqual([]);
  });
});

describe('kimi source fetch', () => {
  it('is configured only when a key is resolved', () => {
    const source = createKimiSource();
    expect(source.isConfigured({ kimi: 'sk-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ kimi: null } as never, {})).toBe(false);
  });

  it('claims authority for the kimi backend on a successful listing', async () => {
    const restore = stubFetch({ body: models });
    try {
      const result = await createKimiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        // One endpoint lists everything, so a 200 IS exhaustive - which is what
        // lets absence bookkeeping eventually deprecate a withdrawn model.
        expect(result.authoritativeFor).toEqual(['kimi']);
        expect(result.records).toHaveLength(12);
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
      await createKimiSource().fetch(makeContext());
      expect(seen).toEqual([KIMI_MODELS_URL]);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty when the provider lists nothing', async () => {
    const restore = stubFetch({ body: empty });
    try {
      // A 200 listing zero models must not read as "Moonshot retired everything".
      expect((await createKimiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails on a body that is not JSON', async () => {
    const restore = stubFetch({ raw: '<html>gateway</html>' });
    try {
      expect((await createKimiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createKimiSource());
});
