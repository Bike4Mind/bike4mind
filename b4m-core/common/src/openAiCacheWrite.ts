import { z } from 'zod';

const identity = z.string().min(1).max(256);
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rate = z.number().finite().nonnegative();

const capabilitySchema = z
  .object({
    version: z.literal(1),
    provider: z.literal('openai'),
    endpoint: z.literal('https://api.openai.com/v1'),
    api: z.enum(['chat', 'responses']),
    policy: z.literal('explicit-cache-write-v1'),
    contractId: identity,
    chatWriteDefault: z.enum(['unknown', 'documented_zero']),
  })
  .strict()
  .refine(value => value.api === 'chat' || value.chatWriteDefault === 'unknown', {
    message: 'Only native Chat permits the documented default',
  });

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

function freeze<T>(value: T): Immutable<T> {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value as Immutable<T>;
}

function immutable(value: unknown): boolean {
  return (
    value === null || typeof value !== 'object' || (Object.isFrozen(value) && Object.values(value).every(immutable))
  );
}

export type OpenAiCacheCapabilityInput = z.input<typeof capabilitySchema>;
export type OpenAiCacheCapability = Immutable<z.output<typeof capabilitySchema>>;

export function freezeOpenAiCacheCapability(input: OpenAiCacheCapabilityInput): OpenAiCacheCapability {
  return freeze(capabilitySchema.parse(input));
}

export type OpenAiCounterObservation =
  | { readonly value: number; readonly provenance: 'reported' }
  | { readonly value: 0; readonly provenance: 'documented_default_zero' }
  | { readonly provenance: 'not_reported' };

export type OpenAiUsageIssue =
  | 'unsupported_contract'
  | 'invalid_envelope'
  | 'invalid_identity'
  | 'invalid_usage'
  | 'invalid_input'
  | 'invalid_output'
  | 'invalid_reads'
  | 'invalid_writes'
  | 'missing_required_counter'
  | 'input_partition_exceeded'
  | 'invalid_retention'
  | 'retention_partition_mismatch';

export interface OpenAiUsageObservation {
  readonly version: 1;
  readonly attemptId: string;
  readonly api: 'chat' | 'responses';
  readonly contractId?: string;
  readonly returnedModel?: string;
  readonly actualServiceTier?: string;
  readonly envelopeStatus: 'terminal' | 'partial' | 'missing' | 'invalid' | 'unsupported';
  readonly partitionStatus: 'complete' | 'aggregate_writes_only' | 'unknown';
  readonly inclusiveInput: OpenAiCounterObservation;
  readonly output: OpenAiCounterObservation;
  readonly cachedReads: OpenAiCounterObservation;
  readonly cacheWrites: OpenAiCounterObservation;
  readonly ordinaryInput?: number;
  readonly writes30m?: number;
  readonly writes12h?: number;
  readonly issues: readonly OpenAiUsageIssue[];
}

const ratesSchema = z
  .object({
    input: rate,
    output: rate,
    cachedRead: rate,
    write30m: rate.optional(),
    write12h: rate.optional(),
  })
  .strict();
const contextTierSchema = z.object({ maxInputTokens: tokenCount.positive(), rates: ratesSchema }).strict();
const serviceTierSchema = z
  .object({ serviceTier: identity, contextTiers: z.array(contextTierSchema).min(1).max(32) })
  .strict()
  .refine(
    value =>
      value.contextTiers.every(
        (tier, index, tiers) => index === 0 || tiers[index - 1].maxInputTokens < tier.maxInputTokens
      ),
    {
      message: 'Context thresholds must be strictly increasing',
    }
  );
const frozenRateSchema = z
  .object({
    version: z.literal(1),
    units: z.literal('usd_per_token'),
    capability: capabilitySchema,
    wireModel: identity,
    allowedReturnedModels: z.array(identity).min(1).max(32),
    identityContractId: identity,
    priceSourceId: identity,
    capturedAt: z.iso.datetime(),
    effectiveAt: z.iso.datetime(),
    serviceTiers: z.array(serviceTierSchema).min(1).max(16),
  })
  .strict()
  .refine(value => new Set(value.allowedReturnedModels).size === value.allowedReturnedModels.length, {
    message: 'Returned model identities must be unique',
  })
  .refine(value => new Set(value.serviceTiers.map(tier => tier.serviceTier)).size === value.serviceTiers.length, {
    message: 'Service tiers must be unique',
  })
  .refine(value => Date.parse(value.effectiveAt) <= Date.parse(value.capturedAt), {
    message: 'Rates must be effective when captured',
  });

export type OpenAiFrozenRateContextInput = z.input<typeof frozenRateSchema>;
export type OpenAiFrozenRateContext = Immutable<z.output<typeof frozenRateSchema>>;
export type OpenAiFrozenRates = Immutable<z.output<typeof ratesSchema>>;
export type OpenAiAttemptRateBinding =
  | {
      readonly status: 'resolved';
      readonly returnedModel: string;
      readonly actualServiceTier: string;
      readonly maxInputTokens: number;
      readonly rates: OpenAiFrozenRates;
    }
  | {
      readonly status: 'unresolved';
      readonly reason:
        | 'invalid_context'
        | 'invalid_attempt'
        | 'unadmitted_model'
        | 'unadmitted_service_tier'
        | 'context_out_of_range'
        | 'missing_write_rate';
    };

export function freezeOpenAiRateContext(input: OpenAiFrozenRateContextInput): OpenAiFrozenRateContext {
  return freeze(frozenRateSchema.parse(input));
}

export function bindOpenAiAttemptRates(
  context: OpenAiFrozenRateContext,
  attempt: { returnedModel: string; actualServiceTier: string; inclusiveInputTokens: number }
): OpenAiAttemptRateBinding {
  if (!frozenRateSchema.safeParse(context).success || !immutable(context))
    return { status: 'unresolved', reason: 'invalid_context' };
  if (!tokenCount.safeParse(attempt.inclusiveInputTokens).success)
    return { status: 'unresolved', reason: 'invalid_attempt' };
  if (!context.allowedReturnedModels.includes(attempt.returnedModel))
    return { status: 'unresolved', reason: 'unadmitted_model' };
  const service = context.serviceTiers.find(tier => tier.serviceTier === attempt.actualServiceTier);
  if (!service) return { status: 'unresolved', reason: 'unadmitted_service_tier' };
  const tier = service.contextTiers.find(candidate => attempt.inclusiveInputTokens <= candidate.maxInputTokens);
  if (!tier) return { status: 'unresolved', reason: 'context_out_of_range' };
  if (tier.rates.write30m === undefined || tier.rates.write12h === undefined)
    return { status: 'unresolved', reason: 'missing_write_rate' };
  return {
    status: 'resolved',
    returnedModel: attempt.returnedModel,
    actualServiceTier: attempt.actualServiceTier,
    maxInputTokens: tier.maxInputTokens,
    rates: tier.rates,
  };
}
