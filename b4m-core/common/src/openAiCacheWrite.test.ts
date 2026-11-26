import { describe, expect, it } from 'vitest';
import {
  bindOpenAiAttemptRates,
  freezeOpenAiCacheCapability,
  freezeOpenAiRateContext,
  type OpenAiFrozenRateContextInput,
} from './openAiCacheWrite';

function input(): OpenAiFrozenRateContextInput {
  return {
    version: 1,
    units: 'usd_per_token',
    capability: {
      version: 1,
      provider: 'openai',
      endpoint: 'https://api.openai.com/v1',
      api: 'responses',
      policy: 'explicit-cache-write-v1',
      contractId: 'native-responses-example',
      chatWriteDefault: 'unknown',
    },
    wireModel: 'example-model',
    allowedReturnedModels: ['example-model', 'example-model-snapshot'],
    identityContractId: 'example-identity-policy',
    priceSourceId: 'example-frozen-price',
    capturedAt: '2026-01-01T12:00:00.100Z',
    effectiveAt: '2026-01-01T12:00:00Z',
    serviceTiers: [
      {
        serviceTier: 'standard',
        contextTiers: [
          {
            maxInputTokens: 10_000,
            rates: { input: 2e-6, output: 8e-6, cachedRead: 0.2e-6, write30m: 2.5e-6, write12h: 4e-6 },
          },
          {
            maxInputTokens: 20_000,
            rates: { input: 4e-6, output: 16e-6, cachedRead: 0.4e-6, write30m: 5e-6, write12h: 8e-6 },
          },
        ],
      },
      {
        serviceTier: 'priority',
        contextTiers: [
          {
            maxInputTokens: 20_000,
            rates: { input: 5e-6, output: 20e-6, cachedRead: 0.5e-6, write30m: 6e-6, write12h: 9e-6 },
          },
        ],
      },
    ],
  };
}

function bind(context = freezeOpenAiRateContext(input()), inclusiveInputTokens = 12_000) {
  return bindOpenAiAttemptRates(context, {
    returnedModel: 'example-model-snapshot',
    actualServiceTier: 'standard',
    inclusiveInputTokens,
  });
}

describe('native OpenAI cache capability', () => {
  it('copies and freezes the admitted contract', () => {
    const original = input().capability;
    const capability = freezeOpenAiCacheCapability(original);
    original.contractId = 'changed';
    expect(capability.contractId).toBe('native-responses-example');
    expect(Object.isFrozen(capability)).toBe(true);
  });

  it('does not permit Responses to inherit a Chat default', () => {
    expect(() => freezeOpenAiCacheCapability({ ...input().capability, chatWriteDefault: 'documented_zero' })).toThrow();
  });

  it.each(['https://example.invalid/v1', 'https://api.openai.com/v1/extra', 'http://api.openai.com/v1'])(
    'rejects an unadmitted route %s',
    endpoint => {
      expect(() => freezeOpenAiCacheCapability({ ...input().capability, endpoint } as never)).toThrow();
    }
  );

  it('rejects unknown properties instead of retaining request data', () => {
    expect(() => freezeOpenAiCacheCapability({ ...input().capability, prompt: 'not retained' } as never)).toThrow();
  });
});

describe('OpenAI frozen rate prerequisites', () => {
  it('does not mistake a mutable or shallow-frozen model context for a frozen snapshot', () => {
    expect(
      bindOpenAiAttemptRates(input(), {
        returnedModel: 'example-model',
        actualServiceTier: 'standard',
        inclusiveInputTokens: 500,
      })
    ).toEqual({ status: 'unresolved', reason: 'invalid_context' });
    expect(
      bindOpenAiAttemptRates(Object.freeze(input()), {
        returnedModel: 'example-model',
        actualServiceTier: 'standard',
        inclusiveInputTokens: 500,
      })
    ).toEqual({ status: 'unresolved', reason: 'invalid_context' });
  });

  it('keeps a deep immutable whitelist independent of later catalog mutation', () => {
    const original = input();
    const context = freezeOpenAiRateContext(original);
    original.serviceTiers[0].contextTiers[1].rates.write12h = 1;
    original.allowedReturnedModels.push('changed-model');
    original.capability.contractId = 'changed-policy';
    const resolved = bind(context);
    expect(resolved.status).toBe('resolved');
    if (resolved.status !== 'resolved') throw new Error('Expected rate binding');
    expect(resolved.rates.write12h).toBe(8e-6);
    expect(context.allowedReturnedModels).not.toContain('changed-model');
    expect(context.capability.contractId).toBe('native-responses-example');
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.serviceTiers)).toBe(true);
    expect(Object.isFrozen(resolved.rates)).toBe(true);
    expect(() => Object.assign(resolved.rates, { write12h: 100 })).toThrow();
    expect(resolved).not.toHaveProperty('costUsd');
  });

  it.each([
    [0, 10_000],
    [6_000, 10_000],
    [10_000, 10_000],
    [10_001, 20_000],
    [12_000, 20_000],
    [20_000, 20_000],
  ])('selects the inclusive attempt threshold %s -> %s', (tokens, threshold) => {
    expect(bind(undefined, tokens)).toMatchObject({ status: 'resolved', maxInputTokens: threshold });
  });

  it('selects physical turns separately without applying an aggregated context tier', () => {
    const context = freezeOpenAiRateContext(input());
    expect(bind(context, 6_000)).toMatchObject({ status: 'resolved', maxInputTokens: 10_000 });
    expect(bind(context, 6_000)).toMatchObject({ status: 'resolved', maxInputTokens: 10_000 });
    expect(bind(context, 12_000)).toMatchObject({ status: 'resolved', maxInputTokens: 20_000 });
  });

  it('binds the actual tier independently of any requested mode', () => {
    const context = freezeOpenAiRateContext(input());
    const selected = bindOpenAiAttemptRates(context, {
      returnedModel: 'example-model',
      actualServiceTier: 'priority',
      inclusiveInputTokens: 500,
    });
    expect(selected).toMatchObject({ status: 'resolved', rates: { input: 5e-6 } });
  });

  it.each(['unexpected-model', 'example-model-other', '__proto__', 'constructor'])(
    'rejects unadmitted returned identity %s',
    model => {
      expect(
        bindOpenAiAttemptRates(freezeOpenAiRateContext(input()), {
          returnedModel: model,
          actualServiceTier: 'standard',
          inclusiveInputTokens: 500,
        })
      ).toEqual({ status: 'unresolved', reason: 'unadmitted_model' });
    }
  );

  it.each(['flex', '__proto__', 'toString'])('rejects unadmitted actual tier %s', serviceTier => {
    expect(
      bindOpenAiAttemptRates(freezeOpenAiRateContext(input()), {
        returnedModel: 'example-model',
        actualServiceTier: serviceTier,
        inclusiveInputTokens: 500,
      })
    ).toEqual({ status: 'unresolved', reason: 'unadmitted_service_tier' });
  });

  it('does not extrapolate beyond the frozen context schedule', () => {
    expect(bind(undefined, 20_001)).toEqual({ status: 'unresolved', reason: 'context_out_of_range' });
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid inclusive attempt count %s',
    tokens => {
      expect(bind(undefined, tokens)).toEqual({ status: 'unresolved', reason: 'invalid_attempt' });
    }
  );

  it('distinguishes explicit free rates from missing rates without defaults', () => {
    const original = input();
    original.serviceTiers[0].contextTiers[1].rates.write30m = 0;
    expect(bind(freezeOpenAiRateContext(original))).toMatchObject({ status: 'resolved', rates: { write30m: 0 } });
    delete original.serviceTiers[0].contextTiers[1].rates.write30m;
    expect(bind(freezeOpenAiRateContext(original))).toEqual({ status: 'unresolved', reason: 'missing_write_rate' });
  });

  it.each([-1, NaN, Infinity, -Infinity])('rejects invalid rate %s', invalid => {
    const original = input();
    original.serviceTiers[0].contextTiers[0].rates.write12h = invalid;
    expect(() => freezeOpenAiRateContext(original)).toThrow();
  });

  it('rejects per-million units rather than converting an unverified source', () => {
    expect(() => freezeOpenAiRateContext({ ...input(), units: 'usd_per_million' } as never)).toThrow();
  });

  it('rejects duplicate service modes and model mappings', () => {
    const original = input();
    original.allowedReturnedModels.push(original.allowedReturnedModels[0]);
    expect(() => freezeOpenAiRateContext(original)).toThrow();
    const other = input();
    other.serviceTiers.push(other.serviceTiers[0]);
    expect(() => freezeOpenAiRateContext(other)).toThrow();
  });

  it.each([0, 10_000, 9_999])('rejects a duplicate, decreasing or zero context threshold %s', threshold => {
    const original = input();
    original.serviceTiers[0].contextTiers[1].maxInputTokens = threshold;
    expect(() => freezeOpenAiRateContext(original)).toThrow();
  });

  it('rejects rates effective after capture and invalid date provenance', () => {
    expect(() => freezeOpenAiRateContext({ ...input(), effectiveAt: '2026-01-02T00:00:00Z' })).toThrow();
    expect(() => freezeOpenAiRateContext({ ...input(), capturedAt: 'not a date' })).toThrow();
  });

  it('rejects unbounded identities and schedules', () => {
    expect(() => freezeOpenAiRateContext({ ...input(), wireModel: 'x'.repeat(257) })).toThrow();
    const original = input();
    original.allowedReturnedModels = Array.from({ length: 33 }, (_, index) => 'model-' + index);
    expect(() => freezeOpenAiRateContext(original)).toThrow();
  });
});
