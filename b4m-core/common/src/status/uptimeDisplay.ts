import type { BarCode } from './types';
import type { DisplayState } from './stateOrder';

export const BAR_CODES = ['o', 'd', 'p', 'm', 'x', 'n'] as const satisfies readonly BarCode[];

const BAR_CODE_STATE: Record<Exclude<BarCode, 'x' | 'n'>, DisplayState> = {
  o: 'operational',
  d: 'degraded',
  p: 'partial_outage',
  m: 'major_outage',
};

export function barCodeForState(state: DisplayState): BarCode {
  switch (state) {
    case 'operational':
      return 'o';
    case 'degraded':
      return 'd';
    case 'partial_outage':
      return 'p';
    case 'major_outage':
      return 'm';
    default:
      return 'n';
  }
}

/** `x` (maintenance) and `n` (no data) carry no state. */
export function stateForBarCode(code: BarCode): DisplayState | null {
  return code === 'x' || code === 'n' ? null : BAR_CODE_STATE[code];
}

const FRACTION_SCALE = 100_000;

/**
 * Uptime as a fraction floored to five decimals. 1 only when downtime is exactly 0, so rounding can
 * never show a perfect score for a day with downtime.
 */
export function uptimeFraction(downtimeSeconds: number, observedSeconds: number): number | null {
  if (!Number.isFinite(observedSeconds) || !Number.isFinite(downtimeSeconds)) return null;
  if (!(observedSeconds > 0) || downtimeSeconds < 0) return null;
  if (downtimeSeconds === 0) return 1;
  const scaled = Math.floor(((observedSeconds - downtimeSeconds) / observedSeconds) * FRACTION_SCALE);
  return Math.min(Math.max(scaled, 0), FRACTION_SCALE - 1) / FRACTION_SCALE;
}

/** Floors to the public five-decimal grid without rounding a below-grid value upward. */
export function floorUptimeFraction(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (value >= 1) return 1;
  const bounded = Math.max(0, value);
  const nearest = Math.round(bounded * FRACTION_SCALE);
  const units = nearest / FRACTION_SCALE <= bounded ? nearest : nearest - 1;
  return units / FRACTION_SCALE;
}

/**
 * Basis points (0..10000), floored; 10000 only for an exact 1. A value within float noise of a whole
 * basis point counts as that point, so 0.9995 reads 9995 and never one lower.
 */
export function uptimeToBasisPoints(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  if (fraction >= 1) return 10_000;
  const scaled = Math.max(fraction, 0) * 10_000;
  const nearest = Math.round(scaled);
  const bp = Math.abs(scaled - nearest) < 1e-7 ? nearest : Math.floor(scaled);
  return Math.min(bp, 9_999);
}

/** Display text such as "99.95%", floored to two decimals; "100%" only for an exact 1; "No data" for null. */
export function formatUptimePercent(fraction: number | null): string {
  const bp = uptimeToBasisPoints(fraction);
  if (bp === null) return 'No data';
  if (bp === 10_000) return '100%';
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, '0')}%`;
}

export function formatBasisPoints(bp: number | null): string {
  if (bp === null) return 'No data';
  return formatUptimePercent(bp >= 10_000 ? 1 : bp / 10_000);
}
