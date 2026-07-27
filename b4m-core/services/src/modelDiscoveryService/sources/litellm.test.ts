import type { ModelIdAliasMap } from '@bike4mind/common';
import { describe, expect, it } from 'vitest';
import empty from './__fixtures__/litellm/empty.json';
import expected from './__fixtures__/litellm/expected.json';
import malformed from './__fixtures__/litellm/malformed.json';
import prices from './__fixtures__/litellm/model_prices_and_context_window.json';
import unknownEnum from './__fixtures__/litellm/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import type { JoinTarget } from './aggregator';
import {
  createLiteLlmSource,
  indexLiteLlm,
  LITELLM_PRICES_URL,
  LITELLM_RELEASE_TAG,
  normalizeLiteLlm,
  TOKENS_PER_MTOK,
} from './litellm';

const RUN_AT = new Date('2026-07-26T00:00:00.000Z');

const TARGETS: JoinTarget[] = [
  { modelId: 'claude-opus-4-5-20251101', backend: 'anthropic' },
  { modelId: 'claude-fable-5', backend: 'anthropic' },
  { modelId: 'claude-opus-4-1-20250805', backend: 'anthropic' },
  { modelId: 'gpt-5', backend: 'openai' },
  { modelId: 'gpt-5.4-mini', backend: 'openai' },
  { modelId: 'o3-2025-04-16', backend: 'openai' },
  { modelId: 'whisper-1', backend: 'openai' },
  { modelId: 'gemini-3-pro-preview', backend: 'gemini' },
  { modelId: 'grok-4.5', backend: 'xai' },
  { modelId: 'grok-3-fast', backend: 'xai' },
  { modelId: 'flux-pro-1.1', backend: 'bfl' },
  { modelId: 'global.anthropic.claude-opus-4-8', backend: 'bedrock' },
  { modelId: 'ai21.j2-mid-v1', backend: 'bedrock' },
  { modelId: 'transcribe', backend: 'aws' },
];

const byId = (records: ReturnType<typeof normalizeLiteLlm>['records']) =>
  new Map(records.map(record => [record.modelId, record]));

describe('litellm supply chain', () => {
  it('is pinned to a release tag, never a moving branch', () => {
    expect(LITELLM_RELEASE_TAG).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(LITELLM_PRICES_URL).toContain(`/${LITELLM_RELEASE_TAG}/`);
    for (const moving of ['/main/', '/master/', '/HEAD/', '/refs/heads/']) {
      expect(LITELLM_PRICES_URL).not.toContain(moving);
    }
  });
});

describe('litellm normalization', () => {
  const result = normalizeLiteLlm(prices, TARGETS, RUN_AT);

  it('matches the golden file', () => {
    expect(result.records).toEqual(expected);
  });

  it('converts per-token cost to $/MTok, cache rates included', () => {
    const opus = byId(result.records).get('claude-opus-4-5-20251101');
    expect(prices['claude-opus-4-5-20251101'].input_cost_per_token * TOKENS_PER_MTOK).toBe(5);
    // cache_creation_input_token_cost is litellm's name for the WRITE rate;
    // crossing the two would bill every cache read at the write price.
    expect(opus?.pricing).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
  });

  it('leaves a cache rate the entry does not carry unset', () => {
    expect(byId(result.records).get('gpt-5')?.pricing).toEqual({
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.125,
    });
  });

  it('joins FLUX and Whisper but carries no price, because theirs is not per token', () => {
    // litellm is the only feed pricing these at all, but as output_cost_per_image
    // and input_cost_per_second - units DiscoveredPrice cannot express. The join
    // still counts, so the record goes out empty rather than reading as unmatched.
    for (const modelId of ['flux-pro-1.1', 'whisper-1']) {
      const record = byId(result.records).get(modelId);
      expect(record).toBeDefined();
      expect(record?.pricing).toBeUndefined();
      expect(record?.patch).toEqual({});
    }
    expect(result.unmatched).not.toContain('flux-pro-1.1');
  });

  it('reads supports_sampling_params: false as the no-temperature signal', () => {
    expect(byId(result.records).get('claude-fable-5')?.patch.temperatureMode).toBe('unsupported');
    expect(byId(result.records).get('gpt-5')?.patch).not.toHaveProperty('temperatureMode');
  });

  it('keeps a future deprecation_date without declaring the model deprecated', () => {
    // claude-opus-4-1-20250805 is dated 2026-08-05, ten days after the run.
    expect(byId(result.records).get('claude-opus-4-1-20250805')?.patch.lifecycle).toEqual({
      status: 'active',
      deprecationDate: '2026-08-05',
    });
  });

  it('declares a past deprecation_date deprecated', () => {
    const record = byId(result.records).get('gemini-3-pro-preview');
    expect(record?.patch.lifecycle).toEqual({ status: 'deprecated', deprecationDate: '2026-03-26' });
    // deprecation_date is published as a field, so it is typed evidence.
    expect(record?.lifecycleEvidence).toBe('typed');
  });

  it('resolves a provider-qualified first-party key onto our bare id', () => {
    // xai/grok-4.5 and black_forest_labs/flux-pro-1.1 both collapse to our id.
    expect(byId(result.records).get('grok-4.5')?.patch.contextWindow).toBeGreaterThan(0);
    expect(byId(result.records).has('flux-pro-1.1')).toBe(true);
  });

  it('never lets a reseller spelling outrank the direct key', () => {
    // azure_ai/gpt-5.4-mini and openrouter/openai/gpt-5 are both in the fixture.
    expect(byId(result.records).get('gpt-5')?.patch.contextWindow).toBe(prices['gpt-5'].max_input_tokens);
    expect(byId(result.records).get('gpt-5.4-mini')?.patch.contextWindow).toBe(prices['gpt-5.4-mini'].max_input_tokens);
  });

  it('reports every unmatched id', () => {
    expect(result.unmatched).toEqual(['grok-3-fast', 'transcribe']);
  });

  it('lets an alias rescue an id the normalizer cannot place', () => {
    const aliases: ModelIdAliasMap = { 'grok-3-fast': { litellm: 'xai/grok-3-fast-latest' } };
    const aliased = normalizeLiteLlm(prices, TARGETS, RUN_AT, aliases);
    expect(aliased.unmatched).toEqual(['transcribe']);
    expect(byId(aliased.records).has('grok-3-fast')).toBe(true);
  });

  it('skips sample_spec, which is a template row and not a model', () => {
    expect(indexLiteLlm(prices).has('sample_spec')).toBe(false);
    expect(indexLiteLlm(empty).size).toBe(0);
  });

  it('skips malformed entries and drops an unparseable deprecation date', () => {
    const targets: JoinTarget[] = [
      { modelId: 'claude-opus-4-5-20251101', backend: 'anthropic' },
      { modelId: 'claude-broken', backend: 'anthropic' },
      { modelId: 'claude-array', backend: 'anthropic' },
    ];
    const records = normalizeLiteLlm(malformed, targets, RUN_AT).records;
    expect(records.map(record => record.modelId)).toEqual(['claude-broken', 'claude-opus-4-5-20251101']);
    // Every unusable value is dropped: the entry joins, and says nothing.
    expect(records.find(record => record.modelId === 'claude-broken')).toEqual({ modelId: 'claude-broken', patch: {} });
  });

  it('tolerates a mode and a capability flag this build does not know', () => {
    const records = normalizeLiteLlm(unknownEnum, [{ modelId: 'claude-opus-6', backend: 'anthropic' }], RUN_AT).records;
    expect(records[0]?.patch).toMatchObject({ temperatureMode: 'unsupported', supportsVision: true });
    expect(records[0]?.patch).not.toHaveProperty('mode');
    expect(records[0]?.patch).not.toHaveProperty('supports_hologram_output');
  });

  it('never sets authority-forbidden fields', () => {
    for (const record of result.records) {
      expect(record.patch).not.toHaveProperty('id');
      expect(record.patch).not.toHaveProperty('backend');
      expect(record.patch).not.toHaveProperty('name');
    }
  });
});

describe('litellm source fetch', () => {
  const targets = () => TARGETS;

  it('needs no credential, only egress', () => {
    expect(createLiteLlmSource({ targets }).isConfigured({} as never, {})).toBe(true);
  });

  it('fetches the pinned tag and records a content hash', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: prices };
    });
    try {
      const result = await createLiteLlmSource({ targets }).fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(calls).toEqual([LITELLM_PRICES_URL]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(result.authoritativeFor).toBeUndefined();
      }
    } finally {
      restore();
    }
  });

  it('sends no conditional validator, because a tagged file is immutable', async () => {
    const restore = stubFetch({ body: prices });
    const spy = globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } };
    try {
      await createLiteLlmSource({ targets }).fetch(makeContext({ previous: { etag: '"abc"' } }));
      const [, init] = spy.mock.calls[0] ?? [];
      expect((init?.headers as Record<string, string>)['if-none-match']).toBeUndefined();
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createLiteLlmSource({ targets }));
});
