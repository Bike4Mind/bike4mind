import type { CreditsGlance } from './useCreditsGlance';
import {
  CRITICAL_RUNWAY_DAYS,
  formatRunway,
  LOW_RUNWAY_DAYS_WITHOUT_REFILL,
  type CreditOutlook,
  type CreditTone,
} from './creditOutlook';
import { formatCredits } from './CreditsGlance';

export type CreditsOrbTone = CreditTone | 'unknown';

export type CreditsOrbState = {
  tone: CreditsOrbTone;
  /** The balance being shown, or null when none has been read. */
  balance: number | null;
  /** The balance as the orb prints it ("38k"), or null when none has been read. */
  compact: string | null;
  /** One line on how long the balance lasts, for the popover. Null when there is nothing honest to say. */
  runway: string | null;
};

const TONE_PHRASE: Record<CreditsOrbTone, string> = {
  ok: 'ok',
  low: 'running low',
  critical: 'almost out',
  unknown: 'balance unavailable',
};

/**
 * What the rail orb shows: the balance as text and a status tone, never a fill. Credits are a
 * balance with no maximum, so there is no honest denominator for a fill; the tone answers the
 * real question, how long the balance lasts at the recent pace (expiry-aware, see
 * `projectRunwayDays`). With no pace to project from, the tone stays neutral.
 */
export function creditsOrbState({ outlook, organization, profile }: CreditsGlance): CreditsOrbState {
  const balance = organization ? organization.credits : (profile?.credits.balance ?? null);
  const compact = balance === null ? null : compactCredits(balance);
  if (outlook.kind === 'unknown') return { tone: 'unknown', balance, compact, runway: null };
  return {
    tone: orbTone(outlook),
    balance,
    compact,
    runway: runwayLine(outlook, organization !== null),
  };
}

/**
 * The orb's tone: critical inside two days or at zero, low inside a week unless a refill lands
 * first. Unlike the menu ring's tone, a refill landing later does not turn a long runway amber:
 * the orb is a glance, and "short of the refill" by a day on a month of runway is not urgent.
 * A covered runway matches the menu ring (`creditOutlook`): ok, critical only inside two days.
 */
function orbTone(outlook: Exclude<CreditOutlook, { kind: 'unknown' }>): CreditTone {
  if (outlook.kind === 'empty') return 'critical';
  if (outlook.kind === 'idle') return 'ok';
  if (outlook.runwayDays < CRITICAL_RUNWAY_DAYS) return 'critical';
  if (outlook.kind === 'covered') return 'ok';
  if (outlook.runwayDays < LOW_RUNWAY_DAYS_WITHOUT_REFILL) return 'low';
  return 'ok';
}

function runwayLine(outlook: Exclude<CreditOutlook, { kind: 'unknown' }>, organizationPays: boolean): string | null {
  if (outlook.kind === 'empty') return 'Out of credits';
  if (outlook.kind === 'idle') return organizationPays ? 'Organization pool' : null;
  const span = formatRunway(outlook.runwayDays, outlook.expiryKnown);
  const lead = /^(over|under) /.test(span) ? span.charAt(0).toUpperCase() + span.slice(1) : `About ${span}`;
  return `${lead} at your recent usage`;
}

/**
 * A balance in at most four characters, for the 28px orb: "850", "4.2k", "38k", "999k", "2.5M",
 * "12M", "1B". Always rounded down, so the orb never shows more than there is; the popover
 * carries the exact figure.
 */
export function compactCredits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  const whole = Math.floor(value);
  if (whole < 1_000) return String(whole);
  if (whole < 10_000) return `${trimDecimal(Math.floor(whole / 100) / 10)}k`;
  if (whole < 1_000_000) return `${Math.floor(whole / 1_000)}k`;
  if (whole < 10_000_000) return `${trimDecimal(Math.floor(whole / 100_000) / 10)}M`;
  if (whole < 1_000_000_000) return `${Math.floor(whole / 1_000_000)}M`;
  return `${Math.floor(whole / 1_000_000_000)}B`;
}

function trimDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/** The orb's accessible name; always carries the state, since colour alone cannot. */
export function creditsOrbLabel(state: CreditsOrbState): string {
  const balance = state.balance === null ? '' : `, ${formatCredits(state.balance)} credits`;
  return `Credits: ${TONE_PHRASE[state.tone]}${state.tone === 'unknown' ? '' : balance}`;
}
