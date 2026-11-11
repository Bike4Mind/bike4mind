import { Logger } from '@bike4mind/observability';

export interface NumericSettingSpec {
  key: string;
  fallback: number;
  min: number;
  max: number;
  int?: boolean;
}

/**
 * Parse one numeric admin-setting value read through `getSettingsByNames`. An absent value gives
 * `fallback`; a value above `max` is clamped (with a warning) to the hard rail; an unparseable or
 * below-`min` value throws, so a typo in a limit fails closed instead of silently widening it.
 */
export function parseNumericSetting(raw: unknown, spec: NumericSettingSpec, logger?: Logger): number {
  // `unknown`, not `string`: the admin panel stores typed values, so a cached read can hand back a number.
  if (raw === null || raw === undefined || String(raw).trim() === '') return spec.fallback;
  const parsed = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < spec.min) {
    throw new Error(`setting '${spec.key}' has an invalid value ${JSON.stringify(raw)} (minimum ${spec.min})`);
  }
  const value = spec.int ? Math.floor(parsed) : parsed;
  if (value > spec.max) {
    logger?.warn?.(`setting '${spec.key}' value ${value} is above its ceiling ${spec.max}; using ${spec.max}`);
    return spec.max;
  }
  return value;
}
