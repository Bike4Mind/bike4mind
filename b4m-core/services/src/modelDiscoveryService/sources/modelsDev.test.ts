import { describe, expect, it } from 'vitest';
import apiJson from './__fixtures__/modelsDev/api.json';
import empty from './__fixtures__/modelsDev/empty.json';
import expected from './__fixtures__/modelsDev/expected.json';
import malformed from './__fixtures__/modelsDev/malformed.json';
import unknownEnum from './__fixtures__/modelsDev/unknown-enum.json';
import { expectDegradesOnFailure, makeContext, stubFetch } from './__fixtures__/testSupport';
import type { JoinTarget } from './aggregator';
import { createModelsDevSource, indexModelsDev, MODELS_DEV_URL, normalizeModelsDev } from './modelsDev';

/** A slice of the checked-in catalog seed, spanning every backend models.dev covers. */
const TARGETS: JoinTarget[] = [
  { modelId: 'claude-opus-5', backend: 'anthropic' },
  { modelId: 'claude-opus-4-5-20251101', backend: 'anthropic' },
  { modelId: 'claude-sonnet-4-6', backend: 'anthropic' },
  { modelId: 'gpt-5', backend: 'openai' },
  { modelId: 'gpt-4.1-2025-04-14', backend: 'openai' },
  { modelId: 'o4-mini-2025-04-16', backend: 'openai' },
  { modelId: 'gemini-2.5-pro', backend: 'gemini' },
  { modelId: 'gemini-3-pro-preview', backend: 'gemini' },
  { modelId: 'grok-4.5', backend: 'xai' },
  { modelId: 'us.anthropic.claude-opus-4-1-20250805-v1:0', backend: 'bedrock' },
  { modelId: 'global.anthropic.claude-opus-4-8', backend: 'bedrock' },
  { modelId: 'flux-pro-1.1', backend: 'bfl' },
  { modelId: 'transcribe', backend: 'aws' },
];

const byId = (records: ReturnType<typeof normalizeModelsDev>['records']) =>
  new Map(records.map(record => [record.modelId, record]));

describe('models.dev normalization', () => {
  const result = normalizeModelsDev(apiJson, TARGETS);

  it('matches the golden file', () => {
    expect(result.records).toEqual(expected);
  });

  it('emits patches only for join-resolved ids', () => {
    for (const record of result.records) {
      expect(TARGETS.map(target => target.modelId)).toContain(record.modelId);
    }
  });

  it('reports every unmatched id as a work item', () => {
    // BFL has no first-party models.dev provider and AWS Transcribe is in none.
    expect(result.unmatched).toEqual(['flux-pro-1.1', 'transcribe']);
  });

  it('quotes cost in $/MTok with no conversion, cache rates included', () => {
    expect(byId(result.records).get('claude-opus-5')?.pricing).toEqual({
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
    });
  });

  it('leaves a cache rate the entry does not carry unset', () => {
    // grok-4.5 publishes cache_read and no cache_write. An invented rate would
    // overwrite the one the price row in force already carries.
    expect(byId(result.records).get('grok-4.5')?.pricing).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 6,
      cacheReadPerMTok: 0.3,
    });
    expect(byId(result.records).get('grok-4.5')?.pricing).not.toHaveProperty('cacheWritePerMTok');
  });

  it('reads cost.tiers[] as long-context brackets, cache rates included', () => {
    expect(byId(result.records).get('grok-4.5')?.pricing?.brackets).toEqual([
      { aboveTokens: 200_000, inputPerMTok: 4, outputPerMTok: 12, cacheReadPerMTok: 1 },
    ]);
  });

  it('leaves a model with no tiers flat', () => {
    expect(byId(result.records).get('claude-opus-5')?.pricing).not.toHaveProperty('brackets');
  });

  it('takes the breakpoint from tier.size, never from the context_over_200k key', () => {
    // The legacy key's NAME is fixed while the real breakpoint is not: upstream
    // ships context_over_200k next to a tier of size 272000. Reading the name
    // would start the long-context rate 72k tokens early.
    const document = {
      openai: {
        models: {
          'gpt-luna': {
            cost: {
              input: 0.2,
              output: 1.2,
              tiers: [{ input: 0.4, output: 1.8, tier: { type: 'context', size: 272_000 } }],
              context_over_200k: { input: 0.4, output: 1.8 },
            },
          },
        },
      },
    };
    const records = normalizeModelsDev(document, [{ modelId: 'gpt-luna', backend: 'openai' }]).records;
    expect(records[0]?.pricing?.brackets).toEqual([{ aboveTokens: 272_000, inputPerMTok: 0.4, outputPerMTok: 1.8 }]);
  });

  it('sorts a two-rung ladder ascending and ignores a tier that is not a context bracket', () => {
    const document = {
      openai: {
        models: {
          'gpt-rungs': {
            cost: {
              input: 1,
              output: 5,
              tiers: [
                { input: 4, output: 20, tier: { type: 'context', size: 512_000 } },
                { input: 9, output: 9, tier: { type: 'service', size: 200_000 } },
                { input: 2, output: 10, tier: { type: 'context', size: 200_000 } },
              ],
            },
          },
        },
      },
    };
    const records = normalizeModelsDev(document, [{ modelId: 'gpt-rungs', backend: 'openai' }]).records;
    expect(records[0]?.pricing?.brackets).toEqual([
      { aboveTokens: 200_000, inputPerMTok: 2, outputPerMTok: 10 },
      { aboveTokens: 512_000, inputPerMTok: 4, outputPerMTok: 20 },
    ]);
  });

  it.each([
    ['prices only one direction', { input: 4, tier: { type: 'context', size: 200_000 } }],
    ['has no breakpoint', { input: 4, output: 20, tier: { type: 'context' } }],
    ['has a zero breakpoint', { input: 4, output: 20, tier: { type: 'context', size: 0 } }],
  ])('drops the whole ladder when a context tier %s', (_label, tier) => {
    // Half a ladder would leave the rung we dropped billing at the rate below it,
    // so the observation goes out flat and the tiered row stays a manual edit.
    const document = { openai: { models: { 'gpt-broken': { cost: { input: 1, output: 5, tiers: [tier] } } } } };
    const records = normalizeModelsDev(document, [{ modelId: 'gpt-broken', backend: 'openai' }]).records;
    expect(records[0]?.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 5 });
  });

  it('fills the AWS pricing hole for Bedrock', () => {
    expect(byId(result.records).get('global.anthropic.claude-opus-4-8')?.pricing).toBeDefined();
  });

  it('maps status: deprecated and ignores beta and alpha', () => {
    const deprecated = byId(result.records).get('o4-mini-2025-04-16');
    expect(deprecated?.patch.lifecycle).toEqual({ status: 'deprecated' });
    expect(deprecated?.lifecycleEvidence).toBe('typed');
    const active = byId(result.records).get('claude-opus-5');
    expect(active?.patch).not.toHaveProperty('lifecycle');
    expect(active?.lifecycleEvidence).toBeUndefined();
  });

  it('never claims a reasoning style, only that the model reasons', () => {
    expect(byId(result.records).get('claude-opus-5')?.patch.reasoning).toEqual({ supported: true });
  });

  it('never sets authority-forbidden fields', () => {
    for (const record of result.records) {
      expect(record.patch).not.toHaveProperty('id');
      expect(record.patch).not.toHaveProperty('backend');
      expect(record.patch).not.toHaveProperty('name');
      expect(record.patch).not.toHaveProperty('description');
    }
  });

  it('indexes only providers a ModelBackend maps to, so a reseller cannot shadow a model', () => {
    const indexed = indexModelsDev(apiJson, ['anthropic', 'openai', 'gemini', 'xai', 'bedrock']);
    expect(indexed.has('claude-opus-5')).toBe(true);
    // The fixture carries an `openrouter` provider precisely to prove it is skipped.
    const everything = indexModelsDev(apiJson, ['anthropic', 'openai', 'gemini', 'xai', 'bedrock', 'openrouter']);
    expect(everything.size).toBe(indexed.size);
  });

  it('skips malformed entries and keeps the rest', () => {
    const targets: JoinTarget[] = [
      { modelId: 'claude-opus-5', backend: 'anthropic' },
      { modelId: 'claude-broken-limits', backend: 'anthropic' },
      { modelId: 'claude-empty', backend: 'anthropic' },
    ];
    const records = normalizeModelsDev(malformed, targets).records;
    expect(records.map(record => record.modelId)).toEqual(['claude-broken-limits', 'claude-empty', 'claude-opus-5']);
    // The two broken ones join and carry nothing; the write path counts them.
    expect(records.filter(record => Object.keys(record.patch).length === 0)).toHaveLength(2);
  });

  it('tolerates a status and a modality this build has never seen', () => {
    const records = normalizeModelsDev(unknownEnum, [{ modelId: 'claude-opus-6', backend: 'anthropic' }]).records;
    expect(records[0]?.patch).not.toHaveProperty('lifecycle');
    expect(records[0]?.patch).toMatchObject({
      supportsVision: true,
      supportsPdfInput: true,
      temperatureMode: 'unsupported',
    });
  });

  it('returns nothing when the provider lists no models', () => {
    expect(normalizeModelsDev(empty, TARGETS).records).toEqual([]);
    expect(normalizeModelsDev(null, TARGETS).records).toEqual([]);
  });
});

describe('models.dev source fetch', () => {
  const targets = () => TARGETS;

  it('needs no credential, only egress', () => {
    expect(createModelsDevSource({ targets }).isConfigured({} as never, {})).toBe(true);
  });

  it('records the etag and a content hash of the fetched body', async () => {
    const restore = stubFetch({ body: apiJson, headers: { etag: '"abc123"' } });
    try {
      const result = await createModelsDevSource({ targets }).fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.etag).toBe('"abc123"');
        expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      }
    } finally {
      restore();
    }
  });

  it('fails on a valid-but-empty document instead of reporting a clean run', async () => {
    const restore = stubFetch({ body: {} });
    try {
      const result = await createModelsDevSource({ targets }).fetch(makeContext());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('empty document');
    } finally {
      restore();
    }
  });

  it('never claims authority for a backend, because an aggregator cannot retire a model', async () => {
    const restore = stubFetch({ body: apiJson });
    try {
      const result = await createModelsDevSource({ targets }).fetch(makeContext());
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.authoritativeFor).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('sends If-None-Match and, on 304, reads the body once so coverage stays honest', async () => {
    const seen: Array<string | undefined> = [];
    let call = 0;
    const restore = stubFetch(() => {
      call += 1;
      return call === 1
        ? { status: 304, headers: { etag: '"abc123"' } }
        : { body: apiJson, headers: { etag: '"abc123"' } };
    });
    const spy = globalThis.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } };
    try {
      const result = await createModelsDevSource({ targets }).fetch(makeContext({ previous: { etag: '"abc123"' } }));
      for (const [, init] of spy.mock.calls) {
        seen.push((init.headers as Record<string, string>)['if-none-match']);
      }
      expect(seen).toEqual(['"abc123"', undefined]);
      expect(result.ok).toBe(true);
      // The whole point: a 304 must not turn into an empty aggregator contribution.
      if (result.ok) expect(result.records.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it('fails rather than looping when the host answers 304 unconditionally', async () => {
    const restore = stubFetch({ status: 304 });
    try {
      const result = await createModelsDevSource({ targets }).fetch(makeContext({ previous: { etag: '"abc"' } }));
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it('hits the documented url', async () => {
    const calls: string[] = [];
    const restore = stubFetch(url => {
      calls.push(url);
      return { body: apiJson };
    });
    try {
      await createModelsDevSource({ targets }).fetch(makeContext());
      expect(calls).toEqual([MODELS_DEV_URL]);
    } finally {
      restore();
    }
  });

  expectDegradesOnFailure(() => createModelsDevSource({ targets }));
});
