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
  LITELLM_REF,
  normalizeLiteLlm,
  parseBracketField,
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
  it('reads a moving ref, because a snapshot reports the price a provider used to charge', () => {
    // A release tag froze this feed weeks behind models.dev. The two then disagreed
    // about every repriced model, the agreement check applied neither, and the old
    // rate kept billing - so the ref moves and the guardrails do the protecting.
    expect(LITELLM_REF).toBe('main');
    expect(LITELLM_PRICES_URL).toContain(`/${LITELLM_REF}/`);
  });

  it('builds the url from the one constant, so re-pinning is a single edit', () => {
    expect(LITELLM_PRICES_URL.split('/').filter(Boolean)).toContain(LITELLM_REF);
    expect(LITELLM_PRICES_URL.endsWith('/model_prices_and_context_window.json')).toBe(true);
  });
});

describe('litellm long-context bracket field names', () => {
  it.each([
    ['input_cost_per_token_above_272k_tokens', 'inputPerMTok', 272_000],
    ['output_cost_per_token_above_272k_tokens', 'outputPerMTok', 272_000],
    ['cache_read_input_token_cost_above_272k_tokens', 'cacheReadPerMTok', 272_000],
    ['cache_creation_input_token_cost_above_272k_tokens', 'cacheWritePerMTok', 272_000],
    ['input_cost_per_token_above_128k_tokens', 'inputPerMTok', 128_000],
    ['output_cost_per_token_above_512k_tokens', 'outputPerMTok', 512_000],
  ])('reads %s as the %s rate above %i tokens', (field, rate, aboveTokens) => {
    // The breakpoint comes from the name: 272k here is data, not a constant.
    expect(parseBracketField(field)).toEqual({ rate, aboveTokens });
  });

  it.each([
    // Service tiers of the same bracket, not brackets: pricing one of them as the
    // long-context rate would overcharge or undercharge every long prompt.
    'input_cost_per_token_above_272k_tokens_priority',
    'output_cost_per_token_above_272k_tokens_flex',
    'cache_read_input_token_cost_above_200k_tokens_priority',
    // A cache-TTL lane, and a compound of a TTL lane with a bracket.
    'cache_creation_input_token_cost_above_1hr',
    'cache_creation_input_token_cost_above_1hr_above_200k_tokens',
    // Units DiscoveredPrice cannot express, bracketed or not.
    'input_cost_per_character_above_128k_tokens',
    'input_cost_per_video_per_second_above_15s_interval',
    // The flat rates themselves, and a breakpoint of zero.
    'input_cost_per_token',
    'input_cost_per_token_flex',
    'input_cost_per_token_above_0k_tokens',
  ])('rejects %s', field => {
    expect(parseBracketField(field)).toBeNull();
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

  it('carries the long-context bracket, cache rates and all', () => {
    // xai/grok-4.5 prices above 200k at double its base rate, cache_read included.
    expect(byId(result.records).get('grok-4.5')?.pricing?.brackets).toEqual([
      { aboveTokens: 200_000, inputPerMTok: 4, outputPerMTok: 12, cacheReadPerMTok: 1 },
    ]);
  });

  it('never mistakes a priority or flex lane for a context bracket', () => {
    // The fixture's gemini-3-pro-preview carries _above_200k_tokens_priority
    // variants at double the standard bracket; one bracket is the right answer.
    const brackets = byId(result.records).get('gemini-3-pro-preview')?.pricing?.brackets;
    expect(brackets).toHaveLength(1);
    expect(brackets?.[0]).toMatchObject({ aboveTokens: 200_000, inputPerMTok: 4, outputPerMTok: 18 });
  });

  it('leaves an entry with no bracket fields flat', () => {
    expect(byId(result.records).get('gpt-5')?.pricing).not.toHaveProperty('brackets');
    // claude-opus-4-5 carries cache_creation_input_token_cost_above_1hr, which is a
    // cache TTL and not a context bracket.
    expect(byId(result.records).get('claude-opus-4-5-20251101')?.pricing).not.toHaveProperty('brackets');
  });

  it('drops the whole ladder when a bracket prices only one direction', () => {
    // Upstream really does this: gemini/gemini-1.5-flash publishes an above-128k
    // input rate and no output rate. Half a ladder would bill long prompts at the
    // short-prompt output rate, so the observation goes out flat instead.
    const half = {
      'claude-half-ladder': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
      },
    };
    const records = normalizeLiteLlm(half, [{ modelId: 'claude-half-ladder', backend: 'anthropic' }], RUN_AT).records;
    expect(records[0]?.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it('sorts brackets ascending whatever order the fields arrive in', () => {
    const ladder = {
      'claude-two-rungs': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 5e-6,
        input_cost_per_token_above_512k_tokens: 4e-6,
        output_cost_per_token_above_512k_tokens: 20e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
        output_cost_per_token_above_200k_tokens: 10e-6,
      },
    };
    const records = normalizeLiteLlm(ladder, [{ modelId: 'claude-two-rungs', backend: 'anthropic' }], RUN_AT).records;
    expect(records[0]?.pricing?.brackets).toEqual([
      { aboveTokens: 200_000, inputPerMTok: 2, outputPerMTok: 10 },
      { aboveTokens: 512_000, inputPerMTok: 4, outputPerMTok: 20 },
    ]);
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

  it('keeps a future deprecation_date and claims no status at all', () => {
    // claude-opus-4-1-20250805 is dated 2026-08-05, ten days after the run. An
    // announced date is not a state: 'active' here would walk a model the
    // catalog holds as deprecated back into every picker.
    expect(byId(result.records).get('claude-opus-4-1-20250805')?.patch.lifecycle).toEqual({
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

  it('fetches the ref and records the content hash that is its audit trail', async () => {
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

  it('fails on a valid-but-empty document instead of reporting a clean run', async () => {
    const restore = stubFetch({ body: {} });
    try {
      const result = await createLiteLlmSource({ targets }).fetch(makeContext({ runStartedAt: RUN_AT }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('empty document');
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createLiteLlmSource({ targets }));
});
