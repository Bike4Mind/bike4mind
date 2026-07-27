import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/ollama/empty.json';
import expected from './__fixtures__/ollama/expected.json';
import legacyTags from './__fixtures__/ollama/legacy-tags.json';
import malformed from './__fixtures__/ollama/malformed.json';
import show from './__fixtures__/ollama/show.json';
import tags from './__fixtures__/ollama/tags.json';
import unknownEnum from './__fixtures__/ollama/unknown-enum.json';
import version from './__fixtures__/ollama/version.json';
import { expectDegradesOnFailure, CREDENTIALS, makeContext, stubFetch } from './__fixtures__/testSupport';
import { contextFromModelInfo, createOllamaSource, normalizeOllamaModels, tagsCarryCapabilities } from './ollama';

const BASE = CREDENTIALS.ollama as string;
const byId = (facts: Parameters<typeof normalizeOllamaModels>[0]) =>
  new Map(normalizeOllamaModels(facts).map(record => [record.modelId, record]));

describe('ollama normalization', () => {
  it('matches the golden file for the captured /api/tags', () => {
    expect(normalizeOllamaModels({ tags })).toEqual(expected);
  });

  it('reads capabilities straight off the tag on the fast path', () => {
    const record = byId({ tags }).get('qwen3.6:35b-a3b-q4_K_M');
    expect(record?.patch).toMatchObject({
      contextWindow: 262144,
      supportsVision: true,
      supportsTools: true,
      reasoning: { supported: true, style: 'ollama' },
      freeToRun: true,
    });
  });

  it('classifies an embedding model by capability, not by name', () => {
    expect(byId({ tags }).get('qwen3-embedding:0.6b')?.patch.type).toBe('embedding');
    expect(byId({ tags }).get('gemma4:26b-a4b-it-q4_K_M')?.patch.type).toBe('text');
  });

  it('falls back to /api/show model_info for a tag that omits the context length', () => {
    const withoutShow = byId({ tags }).get('gemma4:26b-a4b-it-q4_K_M');
    expect(withoutShow?.patch.contextWindow).toBe(0);

    const shown = new Map([['gemma4:26b-a4b-it-q4_K_M', show]]);
    const withShow = byId({ tags: legacyTags, shown }).get('gemma4:26b-a4b-it-q4_K_M');
    expect(withShow?.patch.contextWindow).toBe(262144);
    expect(withShow?.patch.supportsVision).toBe(true);
  });

  it('finds the context length under whatever architecture prefix the model uses', () => {
    expect(contextFromModelInfo({ 'gemma4.context_length': 262144 })).toBe(262144);
    expect(contextFromModelInfo({ 'llama.context_length': 0, 'qwen3.context_length': 32768 })).toBe(32768);
    expect(contextFromModelInfo({ 'general.architecture': 'gemma4' })).toBeUndefined();
    expect(contextFromModelInfo(undefined)).toBeUndefined();
  });

  it('skips malformed entries and keeps the rest', () => {
    const records = normalizeOllamaModels({ tags: malformed });
    expect(records.map(record => record.modelId)).toEqual(['broken:latest', 'qwen3.5:2b-q4_K_M']);
    expect(records.find(record => record.modelId === 'broken:latest')?.patch.contextWindow).toBe(0);
  });

  it('tolerates capability values this build has never heard of', () => {
    const record = normalizeOllamaModels({ tags: unknownEnum })[0];
    expect(record?.patch).toMatchObject({ supportsVision: true, supportsTools: true, contextWindow: 1048576 });
  });

  it('returns nothing for a daemon with nothing pulled', () => {
    expect(normalizeOllamaModels({ tags: empty })).toEqual([]);
  });
});

describe('ollama version gate', () => {
  it('takes the fast path from 0.30 up', () => {
    expect(tagsCarryCapabilities('0.31.1')).toBe(true);
    expect(tagsCarryCapabilities('v0.30.0')).toBe(true);
    expect(tagsCarryCapabilities('1.0.0')).toBe(true);
  });

  it('falls back below 0.30 and for an unreadable version', () => {
    expect(tagsCarryCapabilities('0.29.9')).toBe(false);
    expect(tagsCarryCapabilities('unknown')).toBe(false);
    expect(tagsCarryCapabilities(undefined)).toBe(false);
  });
});

describe('ollama source fetch', () => {
  const route = (body: unknown) => (url: string) => {
    if (url === `${BASE}/api/version`) return { body };
    if (url === `${BASE}/api/tags`) return { body: tags };
    if (url === `${BASE}/api/show`) return { body: show };
    return undefined;
  };

  it('is configured only when a base url is resolved', () => {
    const source = createOllamaSource();
    expect(source.isConfigured({ ollama: 'http://localhost:11434' } as never, {})).toBe(true);
    expect(source.isConfigured({ ollama: null } as never, {})).toBe(false);
  });

  it('kills the N+1: a 0.30+ daemon is one version call and one tags call', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return route(version)(url);
    });
    try {
      const result = await createOllamaSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(calls).toEqual([`${BASE}/api/version`, `${BASE}/api/tags`]);
    } finally {
      restore();
    }
  });

  it('falls back to one /api/show per model below 0.30', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      if (url === `${BASE}/api/tags`) return { body: legacyTags };
      return route({ version: '0.29.4' })(url);
    });
    try {
      const result = await createOllamaSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      expect(calls.filter(url => url === `${BASE}/api/show`)).toHaveLength(legacyTags.models.length);
    } finally {
      restore();
    }
  });

  it('claims authority for the ollama backend when models are present', async () => {
    const restore = stubFetch(route(version));
    try {
      const result = await createOllamaSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toEqual(['ollama']);
    } finally {
      restore();
    }
  });

  it('succeeds without authority on an empty daemon, so no local row is retired', async () => {
    const restore = stubFetch(url => (url === `${BASE}/api/tags` ? { body: empty } : route(version)(url)));
    try {
      const result = await createOllamaSource().fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.records).toEqual([]);
        expect(result.authoritativeFor).toBeUndefined();
      }
    } finally {
      restore();
    }
  });

  it('fails when the daemon is unreachable rather than reporting an empty catalog', async () => {
    const restore = stubFetch({ status: 500, body: {} });
    try {
      expect((await createOllamaSource().fetch(makeContext())).ok).toBe(false);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createOllamaSource());
});
