import {
  freezeOpenAiCacheCapability,
  type OpenAiCacheCapability,
  type OpenAiCounterObservation,
  type OpenAiUsageIssue,
  type OpenAiUsageObservation,
} from '@bike4mind/common';

const absent: OpenAiCounterObservation = Object.freeze({ provenance: 'not_reported' });

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    ? (value as Record<string, unknown>)
    : undefined;
}

function property(value: Record<string, unknown> | undefined, key: string): unknown {
  return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function decodeOpenAiUsageObservation(
  envelope: unknown,
  options: {
    attemptId: string;
    api: 'chat' | 'responses';
    terminal: boolean;
    capability?: OpenAiCacheCapability;
  }
): OpenAiUsageObservation {
  if (!boundedIdentity(options.attemptId)) throw new Error('Invalid provider attempt identity');
  if (!['chat', 'responses'].includes(options.api) || typeof options.terminal !== 'boolean')
    throw new Error('Invalid provider usage context');
  const issues: OpenAiUsageIssue[] = [];
  let capability: OpenAiCacheCapability | undefined;
  try {
    capability = options.capability && freezeOpenAiCacheCapability(options.capability);
    if (capability?.api !== options.api) capability = undefined;
  } catch {
    capability = undefined;
  }
  const base = {
    version: 1 as const,
    attemptId: options.attemptId,
    api: options.api,
    ...(capability ? { contractId: capability.contractId } : {}),
    inclusiveInput: absent,
    output: absent,
    cachedReads: absent,
    cacheWrites: absent,
  };
  if (!capability)
    return Object.freeze({
      ...base,
      envelopeStatus: 'unsupported',
      partitionStatus: 'unknown',
      issues: Object.freeze(['unsupported_contract'] as const),
    });
  const body = record(envelope);
  if (!body)
    return Object.freeze({
      ...base,
      envelopeStatus: 'invalid',
      partitionStatus: 'unknown',
      issues: Object.freeze(['invalid_envelope'] as const),
    });
  const identities: { returnedModel?: string; actualServiceTier?: string } = {};
  for (const [key, destination] of [
    ['model', 'returnedModel'],
    ['service_tier', 'actualServiceTier'],
  ] as const) {
    const value = property(body, key);
    if (value === undefined || value === null) continue;
    if (boundedIdentity(value)) identities[destination] = value;
    else issues.push('invalid_identity');
  }
  const rawUsage = property(body, 'usage');
  if (rawUsage === undefined || rawUsage === null)
    return Object.freeze({
      ...base,
      ...identities,
      envelopeStatus: issues.length ? 'invalid' : options.terminal ? 'missing' : 'partial',
      partitionStatus: 'unknown',
      issues: Object.freeze(issues),
    });
  const usage = record(rawUsage);
  if (!usage)
    return Object.freeze({
      ...base,
      ...identities,
      envelopeStatus: 'invalid',
      partitionStatus: 'unknown',
      issues: Object.freeze([...issues, 'invalid_usage'] satisfies OpenAiUsageIssue[]),
    });
  const read = (value: unknown, issue: OpenAiUsageIssue, required = false): OpenAiCounterObservation => {
    if (value === undefined) {
      if (required) issues.push('missing_required_counter');
      return absent;
    }
    if (!count(value)) {
      issues.push(issue);
      return absent;
    }
    return Object.freeze({ value, provenance: 'reported' });
  };
  const inclusiveInput = read(
    property(usage, options.api === 'chat' ? 'prompt_tokens' : 'input_tokens'),
    'invalid_input',
    true
  );
  const output = read(
    property(usage, options.api === 'chat' ? 'completion_tokens' : 'output_tokens'),
    'invalid_output',
    true
  );
  const rawDetails = property(usage, options.api === 'chat' ? 'prompt_tokens_details' : 'input_tokens_details');
  const details = record(rawDetails);
  if (rawDetails !== undefined && !details) issues.push('invalid_usage');
  const rawWrites = property(details, 'cache_write_tokens');
  const cachedReads = read(property(details, 'cached_tokens'), 'invalid_reads', options.api === 'responses');
  let cacheWrites = read(rawWrites, 'invalid_writes', options.api === 'responses');
  if (
    rawWrites === undefined &&
    options.api === 'chat' &&
    options.terminal &&
    details !== undefined &&
    issues.length === 0 &&
    'value' in inclusiveInput &&
    'value' in output &&
    (!('value' in cachedReads) || cachedReads.value <= inclusiveInput.value) &&
    capability.chatWriteDefault === 'documented_zero'
  ) {
    cacheWrites = Object.freeze({ value: 0, provenance: 'documented_default_zero' });
  }
  let ordinaryInput: number | undefined;
  if ('value' in inclusiveInput) {
    const exceeded =
      ('value' in cachedReads && cachedReads.value > inclusiveInput.value) ||
      ('value' in cacheWrites && cacheWrites.value > inclusiveInput.value) ||
      ('value' in cachedReads &&
        'value' in cacheWrites &&
        cacheWrites.value > inclusiveInput.value - cachedReads.value);
    if (exceeded) issues.push('input_partition_exceeded');
    else if ('value' in cachedReads && 'value' in cacheWrites)
      ordinaryInput = inclusiveInput.value - cachedReads.value - cacheWrites.value;
  }
  let writes30m: number | undefined;
  let writes12h: number | undefined;
  const rawRetention = property(details, 'cache_write_tokens_details');
  if (options.api === 'responses' && rawRetention !== undefined) {
    const retention = record(rawRetention);
    const short = property(retention, 'ttl_30m_tokens');
    const long = property(retention, 'ttl_12h_tokens');
    if (!count(short) || !count(long)) issues.push('invalid_retention');
    else {
      writes30m = short;
      writes12h = long;
      if (!('value' in cacheWrites) || writes30m > cacheWrites.value || writes12h !== cacheWrites.value - writes30m)
        issues.push('retention_partition_mismatch');
    }
  }
  const valid = issues.length === 0;
  const partitionStatus =
    !valid || ordinaryInput === undefined
      ? 'unknown'
      : 'value' in cacheWrites && (cacheWrites.value === 0 || writes30m !== undefined)
        ? 'complete'
        : 'aggregate_writes_only';
  return Object.freeze({
    ...base,
    ...identities,
    inclusiveInput,
    output,
    cachedReads,
    cacheWrites,
    ...(ordinaryInput === undefined ? {} : { ordinaryInput }),
    ...(writes30m === undefined ? {} : { writes30m }),
    ...(writes12h === undefined ? {} : { writes12h }),
    envelopeStatus: valid ? (options.terminal ? 'terminal' : 'partial') : 'invalid',
    partitionStatus,
    issues: Object.freeze(issues),
  });
}
