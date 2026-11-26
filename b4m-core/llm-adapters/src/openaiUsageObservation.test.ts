import { describe, expect, it } from 'vitest';
import { freezeOpenAiCacheCapability } from '@bike4mind/common';
import { decodeOpenAiUsageObservation } from './openaiUsageObservation';

function options(api: 'chat' | 'responses' = 'responses') {
  return {
    api,
    attemptId: 'example-attempt',
    terminal: true,
    capability: freezeOpenAiCacheCapability({
      version: 1,
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      api,
      policy: 'explicit-cache-write-v1',
      contractId: 'example-native-contract',
      chatWriteDefault: 'unknown',
    }),
  };
}

function response() {
  return {
    model: 'example-model-snapshot',
    service_tier: 'standard',
    usage: {
      input_tokens: 12_000,
      output_tokens: 500,
      input_tokens_details: {
        cached_tokens: 4_000,
        cache_write_tokens: 7_000,
        cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
      },
    },
    output: [{ content: [{ text: 'Not retained' }] }],
  };
}

function chat(writes: unknown = 7_000) {
  return {
    model: 'example-model',
    usage: {
      prompt_tokens: 12_000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 4_000, cache_write_tokens: writes },
    },
  };
}

describe('pure native OpenAI usage observation', () => {
  it('keeps disjoint numeric facts without producing a price or canonical money buckets', () => {
    const observed = decodeOpenAiUsageObservation(response(), options());
    expect(observed).toMatchObject({
      version: 1,
      attemptId: 'example-attempt',
      api: 'responses',
      returnedModel: 'example-model-snapshot',
      actualServiceTier: 'standard',
      envelopeStatus: 'terminal',
      partitionStatus: 'complete',
      inclusiveInput: { value: 12_000, provenance: 'reported' },
      output: { value: 500, provenance: 'reported' },
      cachedReads: { value: 4_000, provenance: 'reported' },
      cacheWrites: { value: 7_000, provenance: 'reported' },
      ordinaryInput: 1_000,
      writes30m: 3_000,
      writes12h: 4_000,
      issues: [],
    });
    expect(observed).not.toHaveProperty('costUsd');
    expect(observed).not.toHaveProperty('cacheCreationInputTokens');
    expect(observed).not.toHaveProperty('output[0].content');
    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.cacheWrites)).toBe(true);
    expect(Object.isFrozen(observed.issues)).toBe(true);
  });

  it('does not infer Chat write retention from its request policy', () => {
    const observed = decodeOpenAiUsageObservation(chat(), options('chat'));
    expect(observed).toMatchObject({
      envelopeStatus: 'terminal',
      partitionStatus: 'aggregate_writes_only',
      ordinaryInput: 1_000,
      cacheWrites: { value: 7_000, provenance: 'reported' },
    });
    expect(observed.writes30m).toBeUndefined();
    expect(observed.writes12h).toBeUndefined();
  });

  it('ignores undocumented Chat lifetime detail instead of assigning it a price class', () => {
    const envelope = chat();
    Object.assign(envelope.usage.prompt_tokens_details, {
      cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
    });
    expect(decodeOpenAiUsageObservation(envelope, options('chat')).partitionStatus).toBe('aggregate_writes_only');
  });

  it.each([undefined, null])('missing whole usage %s is not measured zero', usage => {
    const observed = decodeOpenAiUsageObservation({ model: 'example-model', usage }, options());
    expect(observed.envelopeStatus).toBe('missing');
    expect(observed.cacheWrites).toEqual({ provenance: 'not_reported' });
    expect(observed.partitionStatus).toBe('unknown');
  });

  it('marks an interrupted stream without final usage partial', () => {
    expect(decodeOpenAiUsageObservation({ usage: null }, { ...options('chat'), terminal: false })).toMatchObject({
      envelopeStatus: 'partial',
      partitionStatus: 'unknown',
      cacheWrites: { provenance: 'not_reported' },
    });
  });

  it('preserves a partial valid observation without claiming a terminal receipt', () => {
    expect(decodeOpenAiUsageObservation(response(), { ...options(), terminal: false })).toMatchObject({
      envelopeStatus: 'partial',
      ordinaryInput: 1_000,
      cacheWrites: { value: 7_000, provenance: 'reported' },
    });
  });

  it('keeps absent Chat writes unknown unless an eligible native default is admitted', () => {
    const envelope = chat(undefined);
    delete (envelope.usage.prompt_tokens_details as { cache_write_tokens?: unknown }).cache_write_tokens;
    expect(decodeOpenAiUsageObservation(envelope, options('chat')).cacheWrites).toEqual({ provenance: 'not_reported' });
    const configuration = options('chat');
    const capability = freezeOpenAiCacheCapability({
      ...configuration.capability,
      chatWriteDefault: 'documented_zero',
    });
    expect(decodeOpenAiUsageObservation(envelope, { ...configuration, capability })).toMatchObject({
      cacheWrites: { value: 0, provenance: 'documented_default_zero' },
      ordinaryInput: 8_000,
      partitionStatus: 'complete',
    });
    expect(decodeOpenAiUsageObservation(chat(0), { ...configuration, capability }).cacheWrites).toEqual({
      value: 0,
      provenance: 'reported',
    });
  });

  it('does not apply a default to an invalid or partial envelope', () => {
    const configuration = options('chat');
    const capability = freezeOpenAiCacheCapability({
      ...configuration.capability,
      chatWriteDefault: 'documented_zero',
    });
    const envelope = { usage: { prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } };
    expect(decodeOpenAiUsageObservation(envelope, { ...configuration, capability }).cacheWrites).toEqual({
      provenance: 'not_reported',
    });
    expect(
      decodeOpenAiUsageObservation(
        { usage: { ...envelope.usage, completion_tokens: 1 } },
        {
          ...configuration,
          capability,
          terminal: false,
        }
      ).cacheWrites
    ).toEqual({ provenance: 'not_reported' });
    expect(decodeOpenAiUsageObservation({ usage: null }, { ...configuration, capability }).cacheWrites).toEqual({
      provenance: 'not_reported',
    });
  });

  it('keeps an absent details object unknown and malformed present details invalid', () => {
    const configuration = options('chat');
    const capability = freezeOpenAiCacheCapability({
      ...configuration.capability,
      chatWriteDefault: 'documented_zero',
    });
    expect(
      decodeOpenAiUsageObservation(
        { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: {} } },
        {
          ...configuration,
          capability,
        }
      )
    ).toMatchObject({
      cacheWrites: { value: 0, provenance: 'documented_default_zero' },
      cachedReads: { provenance: 'not_reported' },
      partitionStatus: 'unknown',
    });
    expect(
      decodeOpenAiUsageObservation(
        { usage: { prompt_tokens: 10, completion_tokens: 1 } },
        {
          ...configuration,
          capability,
        }
      )
    ).toMatchObject({ cacheWrites: { provenance: 'not_reported' }, partitionStatus: 'unknown' });
    for (const prompt_tokens_details of [null, [], 'invalid']) {
      expect(
        decodeOpenAiUsageObservation(
          { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details } },
          {
            ...configuration,
            capability,
          }
        )
      ).toMatchObject({ envelopeStatus: 'invalid', cacheWrites: { provenance: 'not_reported' } });
    }
  });

  it('does not synthesize default zero for a known impossible read partition', () => {
    const configuration = options('chat');
    const capability = freezeOpenAiCacheCapability({
      ...configuration.capability,
      chatWriteDefault: 'documented_zero',
    });
    expect(
      decodeOpenAiUsageObservation(
        { usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 11 } } },
        { ...configuration, capability }
      )
    ).toMatchObject({
      envelopeStatus: 'invalid',
      partitionStatus: 'unknown',
      cachedReads: { value: 11, provenance: 'reported' },
      cacheWrites: { provenance: 'not_reported' },
      issues: ['input_partition_exceeded'],
    });
  });

  it('does not turn a missing required Responses counter into zero', () => {
    const envelope = response();
    delete (envelope.usage.input_tokens_details as { cache_write_tokens?: number }).cache_write_tokens;
    expect(decodeOpenAiUsageObservation(envelope, options())).toMatchObject({
      envelopeStatus: 'invalid',
      partitionStatus: 'unknown',
      cacheWrites: { provenance: 'not_reported' },
    });
  });

  it('keeps valid facts when another numeric field is invalid', () => {
    const envelope = response();
    envelope.usage.output_tokens = NaN;
    const observed = decodeOpenAiUsageObservation(envelope, options());
    expect(observed.envelopeStatus).toBe('invalid');
    expect(observed.inclusiveInput).toEqual({ value: 12_000, provenance: 'reported' });
    expect(observed.cacheWrites).toEqual({ value: 7_000, provenance: 'reported' });
    expect(observed.output).toEqual({ provenance: 'not_reported' });
    expect(observed.issues).toContain('invalid_output');
  });

  it.each([
    ['input_tokens', -1],
    ['input_tokens', 12_000.5],
    ['input_tokens', Number.MAX_SAFE_INTEGER + 1],
    ['output_tokens', Infinity],
    ['output_tokens', '500'],
    ['output_tokens', null],
  ])('rejects malformed %s=%s', (field, value) => {
    const envelope = response();
    Object.assign(envelope.usage, { [field]: value });
    expect(decodeOpenAiUsageObservation(envelope, options()).envelopeStatus).toBe('invalid');
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7000', null])(
    'rejects invalid write counter %s',
    value => {
      const observed = decodeOpenAiUsageObservation(chat(value), options('chat'));
      expect(observed.envelopeStatus).toBe('invalid');
      expect(observed.cacheWrites).toEqual({ provenance: 'not_reported' });
    }
  );

  it.each([-1, NaN, Infinity, '4000', null])('rejects invalid read counter %s', value => {
    const envelope = response();
    Object.assign(envelope.usage.input_tokens_details, { cached_tokens: value });
    expect(decodeOpenAiUsageObservation(envelope, options()).issues).toContain('invalid_reads');
  });

  it.each([null, [], 'invalid', { ttl_30m_tokens: 7_000 }, { ttl_30m_tokens: -1, ttl_12h_tokens: 7_001 }])(
    'does not fill missing or invalid retention detail %j',
    value => {
      const envelope = response();
      Object.assign(envelope.usage.input_tokens_details, { cache_write_tokens_details: value });
      expect(decodeOpenAiUsageObservation(envelope, options())).toMatchObject({
        envelopeStatus: 'invalid',
        partitionStatus: 'unknown',
        cacheWrites: { value: 7_000, provenance: 'reported' },
      });
    }
  );

  it.each([
    [3_000, 3_999],
    [3_000, 4_001],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('rejects lifetime partition %s/%s without unsafe addition', (short, long) => {
    const envelope = response();
    envelope.usage.input_tokens_details.cache_write_tokens_details = { ttl_30m_tokens: short, ttl_12h_tokens: long };
    expect(decodeOpenAiUsageObservation(envelope, options()).issues).toContain('retention_partition_mismatch');
  });

  it('keeps absent retention unknown but preserves the total and disjoint input', () => {
    const envelope = response();
    delete (envelope.usage.input_tokens_details as { cache_write_tokens_details?: unknown }).cache_write_tokens_details;
    expect(decodeOpenAiUsageObservation(envelope, options())).toMatchObject({
      envelopeStatus: 'terminal',
      partitionStatus: 'aggregate_writes_only',
      ordinaryInput: 1_000,
    });
  });

  it('recognizes explicitly zero writes without inventing a TTL split', () => {
    const observed = decodeOpenAiUsageObservation(chat(0), options('chat'));
    expect(observed).toMatchObject({ ordinaryInput: 8_000, partitionStatus: 'complete' });
    expect(observed.writes30m).toBeUndefined();
    expect(observed.writes12h).toBeUndefined();
  });

  it.each([
    [4_000, 8_001],
    [12_001, 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('rejects overlapping input partitions %s/%s', (reads, writes) => {
    const envelope = chat(writes);
    envelope.usage.prompt_tokens_details.cached_tokens = reads;
    const observed = decodeOpenAiUsageObservation(envelope, options('chat'));
    expect(observed.ordinaryInput).toBeUndefined();
    expect(observed.issues).toContain('input_partition_exceeded');
  });

  it.each(['cached_tokens', 'cache_write_tokens'])(
    'rejects impossible known %s even when the other bucket is unknown',
    field => {
      const observed = decodeOpenAiUsageObservation(
        {
          usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { [field]: 11 } },
        },
        options('chat')
      );
      expect(observed.envelopeStatus).toBe('invalid');
      expect(observed.partitionStatus).toBe('unknown');
      expect(observed.issues).toContain('input_partition_exceeded');
    }
  );

  it('keeps a possible incomplete partition unknown without declaring it invalid', () => {
    expect(
      decodeOpenAiUsageObservation(
        {
          usage: { prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 4 } },
        },
        options('chat')
      )
    ).toMatchObject({
      envelopeStatus: 'terminal',
      partitionStatus: 'unknown',
      cacheWrites: { provenance: 'not_reported' },
      issues: [],
    });
  });

  it('accepts the safe integer boundary without overflowing partition arithmetic', () => {
    const observed = decodeOpenAiUsageObservation(
      {
        usage: {
          prompt_tokens: Number.MAX_SAFE_INTEGER,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: Number.MAX_SAFE_INTEGER, cache_write_tokens: 0 },
        },
      },
      options('chat')
    );
    expect(observed).toMatchObject({ envelopeStatus: 'terminal', partitionStatus: 'complete', ordinaryInput: 0 });
  });

  it('conserves all bounded disjoint partitions and does not mutate envelopes', () => {
    for (let inclusive = 0; inclusive <= 12; inclusive++) {
      for (let reads = 0; reads <= inclusive; reads++) {
        for (let writes = 0; writes <= inclusive - reads; writes++) {
          const envelope = {
            usage: {
              prompt_tokens: inclusive,
              completion_tokens: 0,
              prompt_tokens_details: { cached_tokens: reads, cache_write_tokens: writes },
            },
          };
          const before = JSON.stringify(envelope);
          const observed = decodeOpenAiUsageObservation(envelope, options('chat'));
          expect(observed.ordinaryInput! + reads + writes).toBe(inclusive);
          expect(observed.envelopeStatus).toBe('terminal');
          expect(JSON.stringify(envelope)).toBe(before);
        }
      }
    }
  });

  it('repeated snapshots remain identical rather than accumulating token counts', () => {
    const first = decodeOpenAiUsageObservation(response(), options());
    expect(decodeOpenAiUsageObservation(response(), options())).toEqual(first);
    expect(decodeOpenAiUsageObservation(response(), { ...options(), attemptId: 'next-attempt' }).attemptId).not.toBe(
      first.attemptId
    );
  });

  it('copies observations so subsequent raw response mutation cannot revise them', () => {
    const envelope = response();
    const observed = decodeOpenAiUsageObservation(envelope, options());
    envelope.usage.input_tokens_details.cache_write_tokens = 0;
    envelope.model = 'other';
    expect(observed.cacheWrites).toEqual({ value: 7_000, provenance: 'reported' });
    expect(observed.returnedModel).toBe('example-model-snapshot');
  });

  it('does not grant native semantics to missing, mismatched or forged capabilities', () => {
    expect(decodeOpenAiUsageObservation(response(), { ...options(), capability: undefined }).envelopeStatus).toBe(
      'unsupported'
    );
    expect(
      decodeOpenAiUsageObservation(response(), { ...options(), capability: options('chat').capability }).envelopeStatus
    ).toBe('unsupported');
    const forged = { ...options().capability, endpoint: 'https://example.invalid/v1' };
    expect(decodeOpenAiUsageObservation(response(), { ...options(), capability: forged as never }).envelopeStatus).toBe(
      'unsupported'
    );
  });

  it.each([[], 'not an envelope', 1, null, new Date()])('rejects non-object envelope %j', envelope => {
    expect(decodeOpenAiUsageObservation(envelope, options()).envelopeStatus).toBe('invalid');
  });

  it('does not retain oversized identities or arbitrary payloads', () => {
    const envelope = { ...response(), model: 'x'.repeat(257), privateData: 'not retained' };
    const observed = decodeOpenAiUsageObservation(envelope, options());
    expect(observed.issues).toContain('invalid_identity');
    expect(observed.returnedModel).toBeUndefined();
    expect(JSON.stringify(observed)).not.toContain('not retained');
  });

  it('does not read inherited usage', () => {
    const envelope = Object.create({ usage: response().usage });
    expect(decodeOpenAiUsageObservation(envelope, options()).envelopeStatus).toBe('invalid');
  });

  it('rejects unbounded attempt identity', () => {
    expect(() => decodeOpenAiUsageObservation(response(), { ...options(), attemptId: 'x'.repeat(257) })).toThrow();
  });
});
