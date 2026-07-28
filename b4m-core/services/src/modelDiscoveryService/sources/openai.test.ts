import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/openai/empty.json';
import malformed from './__fixtures__/openai/malformed.json';
import models from './__fixtures__/openai/models.json';
import expected from './__fixtures__/openai/expected.json';
import unknownEnum from './__fixtures__/openai/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { createOpenAiSource, normalizeOpenAiModels, OPENAI_MODELS_URL } from './openai';

describe('openai source normalization', () => {
  it('matches the golden file for the captured response', () => {
    expect(normalizeOpenAiModels(models)).toEqual(expected);
  });

  it('never invents a name or a context window it cannot know', () => {
    for (const record of normalizeOpenAiModels(models)) {
      expect(record.patch).not.toHaveProperty('name');
      expect(record.patch).not.toHaveProperty('contextWindow');
    }
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeOpenAiModels(malformed).map(record => record.modelId)).toEqual(['gpt-5']);
  });

  it('skips an unknown object kind and keeps an unknown owner tier', () => {
    expect(normalizeOpenAiModels(unknownEnum).map(record => record.modelId)).toEqual(['gpt-5', 'gpt-5.7-quantum']);
  });

  it('returns nothing for an empty list rather than inventing rows', () => {
    expect(normalizeOpenAiModels(empty)).toEqual([]);
  });

  it('tolerates a payload that is not a list at all', () => {
    expect(normalizeOpenAiModels(null)).toEqual([]);
    expect(normalizeOpenAiModels({ data: 'nope' })).toEqual([]);
  });
});

describe('openai source fetch', () => {
  it('is configured only when a key is resolved', () => {
    const source = createOpenAiSource();
    expect(source.isConfigured({ openai: 'sk-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ openai: null } as never, {})).toBe(false);
  });

  it('claims authority for the openai backend on a successful listing', async () => {
    const restore = stubFetch({ body: models });
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.authoritativeFor).toEqual(['openai']);
        expect(result.records).toHaveLength(expected.length);
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
      await createOpenAiSource().fetch(makeContext());
      expect(seen).toEqual([OPENAI_MODELS_URL]);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty when the provider lists nothing', async () => {
    const restore = stubFetch({ body: empty });
    try {
      const result = await createOpenAiSource().fetch(makeContext());
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('fails on a body that is not JSON', async () => {
    const restore = stubFetch({ raw: '<html>gateway</html>' });
    try {
      expect((await createOpenAiSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createOpenAiSource());
});
