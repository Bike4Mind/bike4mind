import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/elevenlabs/empty.json';
import expected from './__fixtures__/elevenlabs/expected.json';
import malformed from './__fixtures__/elevenlabs/malformed.json';
import models from './__fixtures__/elevenlabs/models.json';
import unknownEnum from './__fixtures__/elevenlabs/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import { createElevenLabsSource, ELEVENLABS_MODELS_URL, normalizeElevenLabsModels } from './elevenlabs';

const byId = (payload: unknown) => new Map(normalizeElevenLabsModels(payload).map(r => [r.modelId, r]));

describe('elevenlabs normalization', () => {
  it('matches the golden file', () => {
    expect(normalizeElevenLabsModels(models)).toEqual(expected);
  });

  it('separates speech-to-text from speech synthesis', () => {
    expect(byId(models).get('scribe_v1')?.patch.type).toBe('speech-to-text');
    expect(byId(models).get('eleven_v3')?.patch.type).toBe('tts');
  });

  it('emits no backend, because ModelBackend has no elevenlabs member yet', () => {
    for (const record of normalizeElevenLabsModels(models)) {
      expect(record.patch).not.toHaveProperty('backend');
    }
  });

  it('never writes a character limit into the token context window', () => {
    // maximum_text_length_per_request is 10000 CHARACTERS for eleven_v3.
    expect(byId(models).get('eleven_v3')?.patch.contextWindow).toBe(0);
  });

  it('skips malformed entries and keeps the rest', () => {
    expect(normalizeElevenLabsModels(malformed).map(record => record.modelId)).toEqual(['eleven_v3']);
  });

  it('discards fields it has no home for instead of passing them through', () => {
    const record = normalizeElevenLabsModels(unknownEnum)[0];
    expect(record?.modelId).toBe('eleven_v4');
    expect(Object.keys(record?.patch ?? {}).sort()).toEqual(['contextWindow', 'id', 'name', 'type', 'vendor']);
  });

  it('returns nothing for an empty list or a wrapped body', () => {
    expect(normalizeElevenLabsModels(empty)).toEqual([]);
    expect(normalizeElevenLabsModels({ models: [] })).toEqual([]);
  });
});

describe('elevenlabs source fetch', () => {
  it('is configured from its own admin setting', () => {
    const source = createElevenLabsSource();
    expect(source.isConfigured({ elevenlabs: 'xi-live' } as never, {})).toBe(true);
    expect(source.isConfigured({ elevenlabs: null } as never, {})).toBe(false);
  });

  it('claims authority for no backend, so nothing else gets retired on its behalf', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: models };
    });
    try {
      const result = await createElevenLabsSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toBeUndefined();
      expect(calls).toEqual([ELEVENLABS_MODELS_URL]);
    } finally {
      restore();
    }
  });

  it('fails rather than succeeding empty', async () => {
    const restore = stubFetch({ body: empty });
    try {
      expect((await createElevenLabsSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createElevenLabsSource());
});
